import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionStep, ArtifactMeta, ExpectSpec, LocatorSpec } from './types.js';
import { ActionOutcomeUnknownError, err } from './errors.js';
import { resolveLocator, verifyExpects } from './locator.js';
import type { DialogManager } from './connectors.js';
import type { Clock, Logger, PagePort } from './ports.js';

/**
 * 动作执行器（DESIGN §6.4）：
 *  - 派发前 prepared → in_flight（由调用方记账），结果 verified/failed/unknown；
 *  - 超时 ≠ 未执行：TimeoutError 先核实后置状态，无法证实 → ActionOutcomeUnknownError；
 *  - 下载：先注册 download 等待再触发动作，saveAs 到受管 artifact 区（DESIGN §10 [S13]）。
 */

export interface LedgerHook {
  prepared(action: ActionStep, actionRevision: number): void;
  inFlight(action: ActionStep, actionRevision: number): void;
  finished(action: ActionStep, actionRevision: number, state: 'verified' | 'failed' | 'unknown', detail?: Record<string, unknown>): void;
}

export interface ArtifactSink {
  save(filename: string, data: Buffer): ArtifactMeta;
  saveDownload(filename: string, tmpPath: string): ArtifactMeta;
  dir(): string;
}

export class FsArtifactSink implements ArtifactSink {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  dir(): string {
    return this.root;
  }

  save(filename: string, data: Buffer): ArtifactMeta {
    const artifactId = newArtifactId();
    const safe = sanitizeFilename(filename);
    const full = path.join(this.root, `${artifactId}-${safe}`);
    fs.writeFileSync(full, data);
    return meta(artifactId, safe, full);
  }

  saveDownload(filename: string, tmpPath: string): ArtifactMeta {
    const artifactId = newArtifactId();
    const safe = sanitizeFilename(filename);
    const full = path.join(this.root, `${artifactId}-${safe}`);
    fs.copyFileSync(tmpPath, full);
    return meta(artifactId, safe, full);
  }
}

function newArtifactId(): string {
  return `a${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
  return base.length ? base.slice(0, 120) : 'download.bin';
}

function meta(artifactId: string, filename: string, full: string): ArtifactMeta {
  const data = fs.readFileSync(full);
  return {
    artifactId,
    filename,
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

export interface PerformContext {
  vars: Record<string, unknown>;
  values: Record<string, unknown>;
  artifacts: ArtifactSink;
  ledger: LedgerHook;
  actionRevision: number;
  actionTimeoutMs: number;
  /** 取消旗标：派发前检查；在途动作不中断（DESIGN §8.2 cancelling）。 */
  cancelFlag?: { cancelled: boolean };
  dialogs?: DialogManager;
  /** 已授权的 confirm 才允许接受（一次性）。 */
  acceptDialogOnce?: boolean;
}

export interface PerformResult {
  evidence: Record<string, unknown>;
  artifactId?: string;
}

export async function performAction(
  page: PagePort,
  step: ActionStep,
  ctx: PerformContext,
): Promise<PerformResult> {
  if (ctx.cancelFlag?.cancelled) {
    throw err('POLICY_BLOCKED', '任务已进入取消流程，动作未派发');
  }
  ctx.ledger.prepared(step, ctx.actionRevision);
  const timeout = ctx.actionTimeoutMs;
  let downloadPromise: Promise</* DownloadPort */ import('./ports.js').DownloadPort> | undefined;
  const wantsDownload = step.expect.some((e) => e.kind === 'download_completed');

  try {
    ctx.ledger.inFlight(step, ctx.actionRevision);
    const value = resolveValue(step, ctx.values);

    if (step.action === 'click' && wantsDownload) {
      // 先注册下载等待再触发（DESIGN §10 下载正确性）
      downloadPromise = page.waitForDownload({ timeout });
    }
    if (step.action === 'click' && ctx.acceptDialogOnce && ctx.dialogs) {
      ctx.dialogs.armOnce(page, '已授权的预期 confirm');
    }

    switch (step.action) {
      case 'navigate': {
        await page.goto(String(value ?? ''), { timeout, waitUntil: 'load' });
        break;
      }
      case 'click': {
        const loc = requireTarget(page, step).first();
        await loc.click({ timeout });
        break;
      }
      case 'fill': {
        const loc = requireTarget(page, step).first();
        await loc.fill(String(value ?? ''), { timeout });
        break;
      }
      case 'press': {
        const key = step.key ?? 'Enter';
        if (step.target) {
          await resolveLocator(page, step.target).first().press(key, { timeout });
        } else {
          await page.keyboardPress(key);
        }
        break;
      }
      case 'select': {
        const loc = requireTarget(page, step).first();
        await loc.selectOption(String(value ?? ''), { timeout });
        break;
      }
      case 'scroll': {
        const px = Number(value ?? 600);
        await page.mouseWheel(0, Number.isFinite(px) ? px : 600);
        break;
      }
      case 'wait': {
        if (step.target) {
          await resolveLocator(page, step.target).first().waitFor('visible', { timeout });
        } else {
          await page.waitForTimeout(Math.min(Number(value ?? 1000), 5000));
        }
        break;
      }
      case 'screenshot': {
        const buf = await page.screenshot({ fullPage: false });
        const art = ctx.artifacts.save(`shot-${Date.now()}.png`, buf);
        ctx.vars['lastArtifact'] = art.artifactId;
        return { evidence: { screenshot: art.artifactId }, artifactId: art.artifactId };
      }
      default: {
        const never: never = step.action;
        throw err('INVALID_INPUT', `未知动作: ${String(never)}`);
      }
    }

    let artifactId: string | undefined;
    if (downloadPromise) {
      const download = await downloadPromise;
      const suggested = download.suggestedFilename();
      const failure = await download.failure();
      if (failure) throw err('ACTION_FAILED', `下载失败: ${failure}`);
      // saveAs 到受管 artifact 区；临时路径绝不外泄（DESIGN §10 [S13]）
      const tmp = path.join(ctx.artifacts.dir(), `.tmp-${Date.now()}-${suggested}`);
      await download.saveAs(tmp);
      const art = ctx.artifacts.saveDownload(suggested, tmp);
      fs.rmSync(tmp, { force: true });
      artifactId = art.artifactId;
      ctx.vars['lastArtifact'] = artifactId;
    }

    const verdict = await verifyExpects(page, step.expect, { vars: ctx.vars, lastDownload: { artifactId } }, timeout);
    if (!verdict.ok) {
      throw err('ACTION_FAILED', `后置条件未通过: ${verdict.failures.map((f) => f.reason).join('; ')}`.slice(0, 300), {
        details: { failures: verdict.failures },
      });
    }
    return { evidence: { url: page.url() }, artifactId };
  } catch (e) {
    const isTimeout = /timeout|timed out/i.test((e as Error).message) || (e as { name?: string }).name === 'TimeoutError';
    if (isTimeout) {
      // 超时 ≠ 未执行：先核实后置状态（DESIGN §6.4）
      try {
        const verdict = await verifyExpects(page, step.expect, { vars: ctx.vars }, Math.min(timeout, 5000));
        if (verdict.ok) {
          return { evidence: { url: page.url(), verifiedAfterTimeout: true } };
        }
      } catch {
        // 核实本身失败：保持 unknown
      }
      ctx.ledger.finished(step, ctx.actionRevision, 'unknown', { reason: 'timeout' });
      throw new ActionOutcomeUnknownError(`动作超时且无法证实结果，已保持隔离: ${step.action}`, { stepId: step.id });
    }
    if (e instanceof ActionOutcomeUnknownError) throw e;
    const jev = e as { code?: string };
    if (jev?.code === 'POLICY_BLOCKED') throw e;
    throw err('ACTION_FAILED', `动作 ${step.action} 失败: ${(e as Error).message.slice(0, 200)}`);
  }
}

function requireTarget(page: PagePort, step: ActionStep) {
  if (!step.target) throw err('INVALID_INPUT', `动作 ${step.action} 需要 target`);
  return resolveLocator(page, step.target);
}

function resolveValue(step: ActionStep, values: Record<string, unknown>): string | number | undefined {
  if (step.valuesRef !== undefined) {
    const v = values[step.valuesRef];
    if (v === undefined) throw err('INVALID_INPUT', `valuesRef "${step.valuesRef}" 不存在于 values`);
    if (typeof v === 'object' && v !== null && 'secretRef' in v) {
      throw err('INVALID_INPUT', `values["${step.valuesRef}"] 仍是未解析的 secretRef`);
    }
    return String(v);
  }
  return step.value;
}

export { requireTarget };

// ---- 重新导出以便复用 ----
export type { ExpectSpec, LocatorSpec };
