import type { ActionStep, FlowStep, StepResult } from './types.js';
import { err, PauseSignal } from './errors.js';
import { resolveLocator, verifyExpects } from './locator.js';
import { performAction, type ArtifactSink, type LedgerHook, type PerformContext } from './executor.js';
import type { DialogManager } from './connectors.js';
import type { PagePort } from './ports.js';

/**
 * FlowExecutor（DESIGN §8.1）：顺序 action/assert/extract + 单层 branch + 有界 forEach。
 * 实际展开步骤计入全局 maxSteps（不只是计划数组长度）；跨页迭代不保留过期 elementId。
 */

export interface FlowRunContext {
  vars: Record<string, unknown>;
  values: Record<string, unknown>;
  artifacts: ArtifactSink;
  ledger: LedgerHook;
  /** 每个动作派发前分配递增序号（审批 grant 绑定该序号，DESIGN §10）。 */
  nextActionRevision(): number;
  actionTimeoutMs: number;
  cancelFlag: { cancelled: boolean };
  dialogs?: DialogManager;
  acceptDialogOnce?: boolean;
  maxSteps: number;
  /** 动作派发前钩子：PolicyGate + 审批消费（DESIGN §8.2/§10）；抛错则动作不派发。 */
  beforeAction?: (step: ActionStep) => Promise<{ acceptDialogOnce?: boolean } | void>;
  /** 每个步骤边界的截止检查（超限抛错终止）。 */
  checkDeadline?: () => void;
  onProgress?: (r: StepResult) => void;
  goalRunner?: GoalRunner;
}

export type GoalRunner = (
  page: PagePort,
  step: Extract<FlowStep, { kind: 'goal' }>,
  ctx: FlowRunContext,
) => Promise<void>;

export interface FlowRunResult {
  stepResults: StepResult[];
  vars: Record<string, unknown>;
}

export class FlowExecutor {
  private stepCount = 0;
  private readonly results: StepResult[] = [];

  constructor(
    private readonly page: PagePort,
    private readonly ctx: FlowRunContext,
  ) {}

  async run(steps: FlowStep[]): Promise<FlowRunResult> {
    await this.runList(steps);
    return { stepResults: this.results, vars: this.ctx.vars };
  }

  private tick(): void {
    this.stepCount += 1;
    if (this.stepCount > this.ctx.maxSteps) {
      throw err('BUDGET_EXCEEDED', `实际展开步骤超过预算 ${this.ctx.maxSteps}`);
    }
  }

  private async runList(steps: FlowStep[]): Promise<void> {
    for (const step of steps) {
      if (this.ctx.cancelFlag.cancelled) {
        const skipped: StepResult = { id: step.id, kind: step.kind, status: 'skipped' };
        this.results.push(skipped);
        this.ctx.onProgress?.(skipped);
        continue;
      }
      this.ctx.checkDeadline?.();
      const r = await this.runOne(step);
      this.results.push(r);
      this.ctx.onProgress?.(r);
    }
  }

  private async runOne(step: FlowStep): Promise<StepResult> {
    this.tick();
    switch (step.kind) {
      case 'action': {
        const p = this.performCtx();
        if (this.ctx.beforeAction) {
          const gate = await this.ctx.beforeAction(step);
          if (gate?.acceptDialogOnce) p.acceptDialogOnce = true;
        }
        const out = await performAction(this.page, step, p);
        return { id: step.id, kind: 'action', status: 'done', artifactId: out.artifactId };
      }
      case 'assert': {
        const verdict = await verifyExpects(this.page, step.expect, { vars: this.ctx.vars }, this.ctx.actionTimeoutMs);
        if (!verdict.ok) {
          throw err('ACTION_FAILED', `断言失败: ${verdict.failures.map((f) => f.reason).join('; ')}`.slice(0, 300), {
            details: { failures: verdict.failures, stepId: step.id },
          });
        }
        return { id: step.id, kind: 'assert', status: 'done' };
      }
      case 'extract': {
        const count = await resolveLocator(this.page, step.target).count();
        if (count === 0) throw err('ACTION_FAILED', `extract 目标不存在: ${JSON.stringify(step.target)}`);
        const loc = resolveLocator(this.page, step.target).first();
        const saved: Record<string, unknown> = {};
        for (const f of step.fields) {
          if (f === 'text') saved['text'] = await loc.innerText({ timeout: this.ctx.actionTimeoutMs });
          if (f === 'count') saved['count'] = count;
        }
        this.ctx.vars[step.saveAs] = saved;
        return { id: step.id, kind: 'extract', status: 'done', savedAs: step.saveAs };
      }
      case 'branch': {
        const actual = this.ctx.vars[step.variable];
        if (actual === step.equals) {
          await this.runList(step.then);
        }
        return { id: step.id, kind: 'branch', status: 'done' };
      }
      case 'forEach': {
        const items = this.ctx.vars[step.itemsVar];
        if (!Array.isArray(items)) {
          throw err('INVALID_INPUT', `forEach.itemsVar "${step.itemsVar}" 不是数组变量`);
        }
        const bounded = items.slice(0, Math.min(step.maxItems, 30));
        let iterations = 0;
        for (const item of bounded) {
          if (this.ctx.cancelFlag.cancelled) break;
          this.ctx.vars[step.itemVar] = item;
          await this.runList(step.body);
          iterations += 1;
        }
        // 逐项终态记录：未处理项不能计为成功（DESIGN §8.1）
        this.ctx.vars[`${step.itemsVar}.processed`] = iterations;
        this.ctx.vars[`${step.itemsVar}.total`] = items.length;
        if (iterations < items.length) {
          throw new PauseSignal('needs_input', `forEach 未处理完全部条目（${iterations}/${items.length}），已暂停待人工处理`);
        }
        return { id: step.id, kind: 'forEach', status: 'done', iterations };
      }
      case 'goal': {
        if (!this.ctx.goalRunner) throw err('INVALID_INPUT', 'goal 步骤需要 goalRunner（Jev 局部循环，P3）');
        await this.ctx.goalRunner(this.page, step, this.ctx);
        return { id: step.id, kind: 'goal', status: 'done' };
      }
      default: {
        const never: never = step;
        throw err('INVALID_INPUT', `未知步骤类型: ${JSON.stringify(never)}`);
      }
    }
  }

  private performCtx(): PerformContext {
    return {
      vars: this.ctx.vars,
      values: this.ctx.values,
      artifacts: this.ctx.artifacts,
      ledger: this.ctx.ledger,
      actionRevision: this.ctx.nextActionRevision(),
      actionTimeoutMs: this.ctx.actionTimeoutMs,
      cancelFlag: this.ctx.cancelFlag,
      dialogs: this.ctx.dialogs,
      acceptDialogOnce: this.ctx.acceptDialogOnce,
    };
  }
}
