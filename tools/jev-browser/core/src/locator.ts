import type { ExpectSpec, LocatorSpec } from './types.js';
import { err } from './errors.js';
import type { LocatorPort, PagePort } from './ports.js';

/** 白名单定位器映射（DESIGN §8.1）：优先 role/label/testId，css 为显式备用。 */
export function resolveLocator(page: PagePort, spec: LocatorSpec): LocatorPort {
  switch (spec.by) {
    case 'role':
      return page.locator(spec);
    case 'label':
      return page.locator(spec);
    case 'testId':
      return page.locator(spec);
    case 'text':
      return page.locator(spec);
    case 'css':
      return page.locator(spec);
    default: {
      const never: never = spec;
      throw err('INVALID_INPUT', `未知定位器: ${JSON.stringify(never)}`);
    }
  }
}

export interface ExpectContext {
  vars: Record<string, unknown>;
  lastDownload?: { artifactId?: string };
}

/** 后置条件验证（代码可计算事实优先，DESIGN §6.1）。失败不抛错，返回清单。 */
export async function verifyExpects(
  page: PagePort,
  expects: ExpectSpec[],
  ctx: ExpectContext,
  timeoutMs: number,
): Promise<{ ok: boolean; failures: Array<{ kind: string; reason: string }> }> {
  const failures: Array<{ kind: string; reason: string }> = [];
  for (const e of expects) {
    try {
      switch (e.kind) {
        case 'url_contains': {
          if (!page.url().includes(String(e.value ?? ''))) {
            failures.push({ kind: e.kind, reason: `当前 URL ${page.url()} 不含 "${e.value}"` });
          }
          break;
        }
        case 'text_present': {
          const needle = JSON.stringify(e.value ?? '');
          const ok = await page.evaluate(`(document.body && document.body.innerText || '').includes(${needle})`);
          if (!ok) failures.push({ kind: e.kind, reason: `页面文本不含 "${e.value}"` });
          break;
        }
        case 'visible': {
          if (!e.target) throw err('INVALID_INPUT', 'visible 断言需要 target');
          const loc = resolveLocator(page, e.target).first();
          await loc.waitFor('visible', { timeout: timeoutMs });
          break;
        }
        case 'hidden': {
          if (!e.target) throw err('INVALID_INPUT', 'hidden 断言需要 target');
          const loc = resolveLocator(page, e.target).first();
          await loc.waitFor('hidden', { timeout: timeoutMs });
          break;
        }
        case 'count_gte': {
          if (!e.target) throw err('INVALID_INPUT', 'count_gte 断言需要 target');
          const n = await resolveLocator(page, e.target).count();
          if (n < Number(e.value ?? 1)) failures.push({ kind: e.kind, reason: `命中 ${n} 个 < 期望 ${e.value}` });
          break;
        }
        case 'download_completed': {
          if (!ctx.lastDownload?.artifactId) {
            failures.push({ kind: e.kind, reason: '动作未产生受管 artifact' });
          } else if (e.variable) {
            ctx.vars[e.variable] = ctx.lastDownload.artifactId;
          }
          break;
        }
        case 'var_equals': {
          const actual = e.variable ? ctx.vars[e.variable] : undefined;
          if (actual !== e.value) {
            failures.push({ kind: e.kind, reason: `变量 ${e.variable} = ${JSON.stringify(actual)} ≠ ${JSON.stringify(e.value)}` });
          }
          break;
        }
        default: {
          failures.push({ kind: String(e.kind), reason: '未知断言类型' });
        }
      }
    } catch (e2) {
      failures.push({ kind: e.kind, reason: (e2 as Error).message.slice(0, 200) });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** 步骤级 expect 生成：导航/写操作必须提供后置条件（DESIGN §8.1 校验在 flow.ts）。 */
export function hasPostCondition(expect: ExpectSpec[] | undefined): boolean {
  return Array.isArray(expect) && expect.length > 0;
}
