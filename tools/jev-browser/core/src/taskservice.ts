import crypto from 'node:crypto';
import path from 'node:path';
import type {
  ActInput,
  CreateSessionInput,
  ExecuteTaskInput,
  FlowStep,
  PageCandidate,
  PauseReason,
  PendingApproval,
  RunTaskInput,
  SessionInfo,
  StepResult,
  TaskEnvelope,
  TaskStatus,
  ValueInput,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';
import { ActionOutcomeUnknownError, JevError, PauseSignal, err } from './errors.js';
import type { JevBrowserConfig } from './config.js';
import { credentialPresent } from './config.js';
import { TaskStore, type TaskRow } from './store.js';
import { recoverStale, resolveCancelling } from './statemachine.js';
import { PolicyGate, originOf } from './policy.js';
import { observePage } from './observe.js';
import { verifyGrant } from './grants.js';
import { TypeSafeJudge, type JudgePort } from './judge.js';
import { OpenAICompatibleProvider, validatePlannedSteps, type PlannerProvider } from './planner.js';
import { DialogManager, PlaywrightConnector, selectPage } from './connectors.js';
import { FsArtifactSink, type ArtifactSink, type LedgerHook } from './executor.js';
import { FlowExecutor, type FlowRunContext, type GoalRunner } from './flow.js';
import { GoalExecutor } from './goal.js';
import type { BrowserConnector, BrowserPort, Logger, PagePort } from './ports.js';
import { consoleLogger, systemClock, type Clock } from './ports.js';

/** 取消/截止的内部信号（在步骤边界抛出，动作不派发）。 */
class DeadlineSignal extends Error {
  constructor() {
    super('deadline');
    this.name = 'DeadlineSignal';
  }
}

interface RunningCtx {
  taskId: string;
  cancelFlag: { cancelled: boolean };
  stopReason: 'user_cancel' | 'deadline' | 'budget' | 'error';
}

export interface SubmitOptions {
  idempotencyKey?: string;
}

export interface ResumeOptions {
  requestId: string;
  expectedRevision?: number;
  /** 未知结果/歧义暂停后，人工确认允许重跑当前步骤。 */
  rerunConfirmed?: boolean;
}

export interface CancelOptions {
  requestId: string;
  expectedRevision?: number;
}

/** 核心编排（DESIGN §2/§8/§9）：会话、串行队列、预算、取消/恢复/审批、崩溃恢复。 */
export class Runtime {
  readonly store: TaskStore;
  readonly cfg: JevBrowserConfig;
  readonly policy: PolicyGate;
  readonly judge: JudgePort;
  readonly planner: PlannerProvider | null;
  readonly dialogs = new DialogManager();
  private readonly log: Logger;
  private readonly clock: Clock;

  private browser: { port: BrowserPort; ownership: 'borrowed' | 'owned' } | null = null;
  private readonly sessionPages = new Map<string, PagePort>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, RunningCtx>();
  private readonly waiters = new Map<string, (env: TaskEnvelope) => void>();

  constructor(cfg: JevBrowserConfig, opts?: { store?: TaskStore; judge?: JudgePort; planner?: PlannerProvider; logger?: Logger; clock?: Clock; connector?: BrowserConnector }) {
    this.cfg = cfg;
    this.log = opts?.logger ?? consoleLogger();
    this.clock = opts?.clock ?? systemClock();
    this.store = opts?.store ?? new TaskStore(path.join(cfg.runtime.dataDir, 'tasks.db'));
    this.policy = new PolicyGate(cfg);
    this.judge = opts?.judge ?? new TypeSafeJudge(cfg.jev);
    this.planner = opts?.planner ?? this.buildPlanner();
    this.connector = opts?.connector ?? new PlaywrightConnector(cfg);
  }

  private readonly connector: BrowserConnector;

  private buildPlanner(): PlannerProvider | null {
    if (!this.cfg.planner.enabled) return null;
    if (this.cfg.planner.provider !== 'openai-compatible') return null;
    const key = process.env[this.cfg.planner.apiKeyEnv];
    return new OpenAICompatibleProvider({ cfg: this.cfg.planner, apiKey: key });
  }

  profileKey(): string {
    const b = this.cfg.browser;
    return b.mode === 'attach' ? `attach:${b.engine}:${b.attach.endpoint}` : `launch:${b.engine}:${b.launch.userDataDir ?? 'default'}`;
  }

  // ------------------------------------------------------------------
  // 浏览器连接（宿主共享一条连接）
  // ------------------------------------------------------------------

  private async ensureBrowser(): Promise<{ browser: BrowserPort; ownership: 'borrowed' | 'owned' }> {
    if (this.browser) return { browser: this.browser.port, ownership: this.browser.ownership };
    this.acquireHostLock();
    const res = await this.connector.connect();
    this.browser = { port: res.browser, ownership: res.ownership };
    return { browser: res.browser, ownership: res.ownership };
  }

  /** 平台用户级锁（尽力而为）：owner PID 存活检查；不宣称锁住人工/其他软件。 */
  private acquireHostLock(): void {
    const key = `lock:${this.profileKey()}`;
    const raw = this.store.kvGet(key);
    if (raw) {
      try {
        const prev = JSON.parse(raw) as { pid: number };
        if (prev.pid !== process.pid && isPidAlive(prev.pid)) {
          throw err('BROWSER_BUSY', `浏览器已被另一宿主进程占用 (pid=${prev.pid})；请通过其 API 访问或先停止该进程`);
        }
      } catch (e) {
        if ((e as JevError).code === 'BROWSER_BUSY') throw e;
      }
    }
    this.store.kvSet(key, JSON.stringify({ pid: process.pid, at: Date.now() }));
  }

  private heartbeat(): void {
    this.store.kvSet(`lock:${this.profileKey()}`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  }

  // ------------------------------------------------------------------
  // 会话
  // ------------------------------------------------------------------

  async createSession(principal: string, input: CreateSessionInput): Promise<SessionInfo> {
    validateOrigins(input.allowedOrigins, input.modelOrigins);
    const { browser } = await this.ensureBrowser();
    const context = browser.contexts()[0];
    if (!context) throw err('PAGE_NOT_RESOLVED', '浏览器没有可用 context');
    const sessionId = newId('s');
    let page: PagePort | null = null;
    let candidates: PageCandidate[] = [];

    if (input.target.kind === 'new') {
      const url = input.target.url;
      const decision = this.policy.decide({ action: 'navigate', pageUrl: url, navigateTo: url });
      if (!decision.allow) throw err(decision.code, decision.reason);
      page = await context.newPage(url);
      this.sessionPages.set(sessionId, page);
    } else {
      const sel = await selectPage(context, input.target.pageId);
      candidates = sel.candidates;
      if (sel.page) {
        page = sel.page;
        this.sessionPages.set(sessionId, page);
      }
    }

    const status = page ? 'ready' : 'awaiting_page';
    const row = {
      sessionId,
      principal,
      status,
      pageId: page ? guessPageId(context, page) : input.target.kind === 'existing' ? input.target.pageId ?? null : null,
      allowedJson: JSON.stringify(input.allowedOrigins),
      modelJson: JSON.stringify(input.modelOrigins),
    };
    this.store.upsertSession(row);
    return {
      sessionId,
      status,
      pageId: row.pageId ?? undefined,
      candidates: page ? undefined : candidates,
      allowedOrigins: input.allowedOrigins,
      modelOrigins: input.modelOrigins,
    };
  }

  async listPages(principal: string, sessionId: string): Promise<PageCandidate[]> {
    const s = this.requireSession(principal, sessionId);
    const { browser } = await this.ensureBrowser();
    const context = browser.contexts()[0];
    const sel = await selectPage(context, s.pageId ?? undefined);
    return sel.candidates;
  }

  async selectPage(principal: string, sessionId: string, pageId: string): Promise<SessionInfo> {
    const s = this.requireSession(principal, sessionId);
    const { browser } = await this.ensureBrowser();
    const context = browser.contexts()[0];
    const sel = await selectPage(context, pageId);
    if (!sel.page) throw err('PAGE_NOT_RESOLVED', `pageId 不存在: ${pageId}`);
    this.sessionPages.set(sessionId, sel.page);
    const row = { ...s, status: 'ready' as const, pageId };
    this.store.upsertSession(row);
    return { sessionId, status: 'ready', pageId, allowedOrigins: JSON.parse(s.allowedJson) as string[], modelOrigins: JSON.parse(s.modelJson) as string[] };
  }

  async disconnect(principal: string, sessionId: string, opts: { detachTask?: boolean } = {}): Promise<{ disconnected: boolean }> {
    const s = this.requireSession(principal, sessionId);
    const stale = this.store.listStale(['queued', 'running', 'cancelling']).filter((t) => t.sessionId === sessionId);
    if (stale.length > 0) throw err('SESSION_BUSY', `会话仍有活动任务: ${stale.map((t) => t.taskId).join(',')}`);
    const pausedTasks = this.store.listStale(['paused']).filter((t) => t.sessionId === sessionId);
    if (pausedTasks.length > 0 && !opts.detachTask) {
      throw err('SESSION_BUSY', `会话有暂停任务，需显式 detachTask=true（保留预约与审批需求）: ${pausedTasks.map((t) => t.taskId).join(',')}`);
    }
    this.sessionPages.delete(sessionId);
    this.store.upsertSession({ ...s, status: 'disconnected' });
    // 最后一个绑定页且无暂停预约时才关闭宿主连接（DESIGN §4.3）
    const remainingPaused = this.store.listStale(['paused']);
    if (this.sessionPages.size === 0 && remainingPaused.length === 0 && this.browser) {
      await this.browser.port.close().catch(() => undefined);
      this.browser = null;
      this.store.kvDel(`lock:${this.profileKey()}`);
    }
    return { disconnected: true };
  }

  // ------------------------------------------------------------------
  // 任务提交
  // ------------------------------------------------------------------

  async execute(principal: string, sessionId: string, input: ExecuteTaskInput, opts: SubmitOptions = {}): Promise<TaskEnvelope> {
    const s = this.requireSession(principal, sessionId);
    if (s.status !== 'ready') throw err('SESSION_NOT_READY', `会话未就绪（${s.status}），先 select-page`);
    validateExecuteSteps(input.steps);
    return this.enqueueTask(principal, sessionId, 'execute', input, opts, input.budget);
  }

  async run(principal: string, sessionId: string, input: RunTaskInput, opts: SubmitOptions = {}): Promise<TaskEnvelope> {
    const s = this.requireSession(principal, sessionId);
    if (s.status !== 'ready') throw err('SESSION_NOT_READY', `会话未就绪（${s.status}）`);
    if (!input.successCriteria || !input.successCriteria.trim()) {
      throw err('INVALID_INPUT', 'run 需要 successCriteria（DESIGN §8.1：防止规划器自证成功）');
    }
    if (!this.planner) {
      throw err('PLANNER_NOT_CONFIGURED', 'planner 未启用或未配置 provider/baseUrl/model');
    }
    return this.enqueueTask(principal, sessionId, 'run', input, opts, input.budget);
  }

  async act(principal: string, sessionId: string, input: ActInput, opts: SubmitOptions = {}): Promise<TaskEnvelope> {
    this.requireSession(principal, sessionId);
    validateExecuteSteps([input.step]);
    return this.enqueueTask(principal, sessionId, 'act', { sessionId, steps: [input.step], values: input.values }, opts);
  }

  private async enqueueTask(
    principal: string,
    sessionId: string,
    mode: 'execute' | 'run' | 'act',
    request: object,
    opts: SubmitOptions,
    budget?: { deadlineAt?: number },
  ): Promise<TaskEnvelope> {
    const now = this.clock.now();
    const bodyHash = sha256(JSON.stringify(request));
    const taskId = newId('t');
    if (opts.idempotencyKey) {
      const pkey = `submit:${principal}:${mode}:${opts.idempotencyKey}`;
      const existing = this.store.findIdempotent(pkey);
      if (existing) {
        if (existing.bodyHash !== bodyHash) throw err('IDEMPOTENCY_CONFLICT', '相同 Idempotency-Key 但请求体不同');
        const row = this.store.getTask(existing.taskId);
        if (row) return this.envelope(row);
      }
      this.store.putIdempotent(pkey, bodyHash, taskId);
    }
    const deadline = Math.min(
      now + this.cfg.runtime.taskTtlMs,
      budget?.deadlineAt ?? Number.MAX_SAFE_INTEGER,
    );
    const row: TaskRow = {
      taskId,
      sessionId,
      principal,
      mode,
      status: 'queued',
      pauseReason: null,
      revision: 0,
      requestJson: JSON.stringify(request),
      cursor: 0,
      varsJson: '{}',
      resultsJson: '[]',
      metricsJson: JSON.stringify({ queuedMs: 0, runningMs: 0, actions: 0, jevRequests: 0, plannerRequests: 0 }),
      errorJson: null,
      goalJson: null,
      createdAt: now,
      updatedAt: now,
      deadlineAt: deadline === Number.MAX_SAFE_INTEGER ? null : deadline,
    };
    this.store.insertTask(row);

    const pk = this.profileKey();
    const prev = this.queues.get(pk) ?? Promise.resolve();
    const next = prev.then(() => this.runTask(taskId)).catch((e) => {
      this.log.warn(`task ${taskId} 未捕获错误: ${(e as Error).message}`);
    });
    this.queues.set(pk, next);
    return this.envelope(this.store.getTask(taskId)!);
  }

  /** 等待任务到达终态或暂停（CLI 同步语义；HTTP 用轮询）。 */
  waitEnvelope(taskId: string): Promise<TaskEnvelope> {
    const row = this.store.getTask(taskId);
    if (row) {
      const env = this.envelope(row);
      if (env.status === 'paused' || isTerminalStatus(env.status)) return Promise.resolve(env);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const clean = this.waiters.delete(taskId);
        if (clean) reject(err('ACTION_TIMEOUT', '等待任务超时（宿主未在期限内收敛）', { retryable: true }));
      }, 30 * 60_000);
      this.waiters.set(taskId, (env) => {
        clearTimeout(timer);
        resolve(env);
      });
    });
  }

  // ------------------------------------------------------------------
  // 任务执行
  // ------------------------------------------------------------------

  private async runTask(taskId: string): Promise<void> {
    let row = this.store.getTask(taskId);
    if (!row) return;
    if (isTerminalStatus(row.status as TaskStatus)) return;

    const pk = this.profileKey();
    // 隔离检查：存在未知在途动作时拒绝新写任务（DESIGN §8.2）
    const isolation = this.store.kvGet(`isolation:${pk}`);
    if (isolation && isolation !== taskId) {
      this.transitionTo(row, 'failed', { error: { code: 'BROWSER_BUSY', message: `存在未对账的未知在途动作（${isolation}），人工处理前不接新任务`, retryable: false } });
      this.resolveWaiter(taskId);
      return;
    }

    // 排队等待预约释放（paused 也预约整个 profile，DESIGN §8.2）
    const queueDeadline = this.clock.now() + this.cfg.runtime.queueTimeoutMs;
    while (true) {
      const raw = this.store.kvGet(`reserve:${pk}`);
      if (!raw) break;
      try {
        const r = JSON.parse(raw) as { taskId: string };
        if (r.taskId === taskId) break;
      } catch {
        break;
      }
      if (this.clock.now() > queueDeadline || (row.deadlineAt !== null && this.clock.now() > row.deadlineAt)) {
        row = this.store.getTask(taskId)!;
        this.transitionTo(row, 'expired', { error: { code: 'BROWSER_BUSY', message: '等待浏览器预约释放超时', retryable: false } });
        this.resolveWaiter(taskId);
        return;
      }
      await this.clock.sleep(300);
    }
    row = this.store.getTask(taskId)!;
    if (row.status !== 'queued') {
      this.resolveWaiter(taskId);
      return;
    }
    this.store.kvSet(`reserve:${pk}`, JSON.stringify({ taskId, state: 'running', at: Date.now() }));
    this.heartbeat();

    const startedAt = this.clock.now();
    const metrics = JSON.parse(row.metricsJson) as { queuedMs?: number; runningMs?: number; actions?: number; jevRequests?: number; plannerRequests?: number };
    metrics.queuedMs = startedAt - row.createdAt;
    if (!this.transitionTo(row, 'running')) {
      this.resolveWaiter(taskId);
      return;
    }
    const cancelFlag: { cancelled: boolean } = { cancelled: false };
    const runningCtx: RunningCtx = { taskId, cancelFlag, stopReason: 'error' };
    this.running.set(taskId, runningCtx);

    const runDeadline = Math.min(
      row.deadlineAt ?? Number.MAX_SAFE_INTEGER,
      startedAt + this.cfg.runtime.timeoutMs,
    );
    let seq = this.store.maxActionSeq(taskId);
    const results: StepResult[] = JSON.parse(row.resultsJson) as StepResult[];
    const vars = JSON.parse(row.varsJson) as Record<string, unknown>;
    const request = JSON.parse(row.requestJson) as Record<string, unknown>;
    const session = this.store.getSession(row.sessionId);
    const allowedOrigins: string[] = session ? JSON.parse(session.allowedJson) : [];
    const modelOrigins: string[] = session ? JSON.parse(session.modelJson) : [];
    const artifactsDir = path.join(this.cfg.runtime.dataDir, 'artifacts', taskId);
    const artifacts: ArtifactSink = new FsArtifactSink(artifactsDir);

    const persist = (patch: Partial<{ cursor: number; varsJson: string; resultsJson: string; metricsJson: string; errorJson: string | null; goalJson: string | null }> = {}) => {
      const cur = this.store.getTask(taskId);
      if (!cur) return;
      this.store.transition(taskId, cur.revision, {
        status: cur.status,
        pauseReason: cur.pauseReason,
        cursor: patch.cursor ?? cur.cursor,
        varsJson: patch.varsJson ?? JSON.stringify(vars),
        resultsJson: patch.resultsJson ?? JSON.stringify(results),
        metricsJson: patch.metricsJson ?? JSON.stringify({ ...metrics, jevRequests: this.judge.usage().jevRequests }),
        errorJson: patch.errorJson ?? cur.errorJson,
        goalJson: patch.goalJson ?? cur.goalJson,
      });
    };

    const ledger: LedgerHook = {
      prepared: (_s, rev) => this.store.setActionState(taskId, rev, 'prepared', JSON.stringify(revArg(_s))),
      inFlight: (_s, rev) => this.store.setActionState(taskId, rev, 'in_flight'),
      finished: (_s, rev, state, detail) => this.store.setActionState(taskId, rev, state, undefined, detail ? JSON.stringify(detail) : undefined),
    };

    const sessionRow = row;
    const gate = this.makeGate(taskId, () => this.sessionPages.get(sessionRow.sessionId)?.url() ?? '');

    try {
      const page = this.requirePage(row.sessionId);
      let steps: FlowStep[];
      if (row.mode === 'run') {
        const req = request as unknown as { goal: string; successCriteria: string; values?: Record<string, ValueInput> };
        if (!row.goalJson) {
          if (!this.planner) throw err('PLANNER_NOT_CONFIGURED', 'planner 未配置');
          metrics.plannerRequests = (metrics.plannerRequests ?? 0) + 1;
          const planned = await this.planner.plan({
            goal: req.goal,
            successCriteria: req.successCriteria,
            valuesKeys: Object.keys(req.values ?? {}),
            allowedOrigins,
            currentUrl: page.url(),
          });
          if (planned.length === 0) {
            throw new PauseSignal('needs_input', '规划器无法生成计划（目标不可达或信息不足），需人工补充信息');
          }
          persist({ goalJson: JSON.stringify(planned) });
          row = this.store.getTask(taskId)!;
          steps = planned;
        } else {
          steps = JSON.parse(row.goalJson) as FlowStep[];
        }
      } else {
        const req = request as unknown as { steps: FlowStep[] };
        steps = req.steps;
      }

      const goalRunner: GoalRunner = async (p, goalStep, fctx) => {
        const ge = new GoalExecutor(p, {
          goal: goalStep.goal,
          values: fctx.values,
          valuesKeys: Object.keys(fctx.values),
          judge: this.judge,
          modelOrigins,
          allowedOrigins,
          maxActions: this.cfg.runtime.maxActions,
          maxJevRequests: this.cfg.runtime.maxJevRequests,
          actionTimeoutMs: this.cfg.runtime.actionTimeoutMs,
          thresholds: {
            doneAt: this.cfg.jev.doneAt,
            confirmLow: this.cfg.jev.confirmLow,
            confirmHigh: this.cfg.jev.confirmHigh,
          },
          artifacts: fctx.artifacts,
          ledger: fctx.ledger,
          cancelFlag,
          dialogs: fctx.dialogs,
          requestApproval: async (step) => {
            await gate(step); // 允许：返回 true；需要确认：gate 内抛 PauseSignal(needs_confirmation)
            return true;
          },
          nextActionRevision: () => ++seq,
        });
        await ge.run(goalStep.expect);
      };

      const flowCtx: FlowRunContext = {
        vars,
        values: resolveValues((request as unknown as { values?: Record<string, ValueInput> }).values ?? {}),
        artifacts,
        ledger,
        nextActionRevision: () => ++seq,
        actionTimeoutMs: this.cfg.runtime.actionTimeoutMs,
        cancelFlag,
        dialogs: this.dialogs,
        maxSteps: Math.min(this.cfg.runtime.maxSteps, 10_000),
        beforeAction: async (step) => {
          const gateRes = await gate(step);
          return { acceptDialogOnce: gateRes?.acceptDialogOnce };
        },
        checkDeadline: () => {
          if (cancelFlag.cancelled) throw err('POLICY_BLOCKED', '任务已取消');
          if (this.clock.now() > runDeadline) throw new DeadlineSignal();
        },
        goalRunner,
        onProgress: (r) => {
          if (r.kind === 'action' && r.status === 'done') metrics.actions = (metrics.actions ?? 0) + 1;
          if (r.status === 'done' && steps.some((s) => s.id === r.id)) {
            const doneIds = new Set(results.filter((x) => x.status === 'done').map((x) => x.id));
            doneIds.add(r.id);
            const cursor = steps.findIndex((s) => !doneIds.has(s.id));
            persist({ cursor: cursor === -1 ? steps.length : cursor });
          }
        },
      };

      // 断点续跑：cursor 之前的顶层步骤已完成
      const remaining = steps.slice(row.cursor);
      const flow = new FlowExecutor(page, flowCtx);
      await flow.run(remaining);

      if (cancelFlag.cancelled) {
        row = this.store.getTask(taskId)!;
        this.transitionTo(row, resolveCancelling(runningCtx.stopReason), { resultsJson: JSON.stringify(results), metricsJson: JSON.stringify(metrics) });
      } else {
        let verification: { by: 'deterministic' | 'semantic'; ok: boolean; detail?: string };
        if (row.mode === 'run') {
          const req = request as unknown as { successCriteria: string };
          const p = await this.judge.check({ url: page.url(), evidence: results.filter((r) => r.status === 'done').length }, `任务级验收：${req.successCriteria}`);
          if (p < 0.7) {
            throw new PauseSignal('needs_input', `规划步骤完成但任务级验收未证实（p=${p.toFixed(2)}）：${req.successCriteria}`);
          }
          verification = { by: 'semantic', ok: true, detail: `p=${p.toFixed(2)}` };
        } else {
          verification = { by: 'deterministic', ok: true };
        }
        row = this.store.getTask(taskId)!;
        this.store.transition(taskId, row.revision, {
          status: 'done',
          goalJson: JSON.stringify(verification),
          resultsJson: JSON.stringify(results),
          varsJson: JSON.stringify(vars),
          metricsJson: JSON.stringify(metrics),
        });
      }
    } catch (e) {
      row = this.store.getTask(taskId)!;
      if (e instanceof DeadlineSignal || cancelFlag.cancelled) {
        const target = e instanceof DeadlineSignal ? 'expired' : resolveCancelling(runningCtx.stopReason);
        this.transitionTo(row, target, { resultsJson: JSON.stringify(results), metricsJson: JSON.stringify(metrics) });
      } else if (e instanceof PauseSignal) {
        const pending = (e.detail as { pendingApproval?: PendingApproval } | undefined)?.pendingApproval;
        this.transitionTo(row, 'paused', {
          errorJsonRaw: pending ? JSON.stringify({ code: 'NEEDS_CONFIRMATION', message: e.message, pendingApproval: pending }) : JSON.stringify({ code: 'NEEDS_INPUT', message: e.message }),
          resultsJson: JSON.stringify(results),
          metricsJson: JSON.stringify(metrics),
        }, e.reason);
      } else if (e instanceof ActionOutcomeUnknownError) {
        this.store.kvSet(`isolation:${pk}`, JSON.stringify({ taskId, at: Date.now(), reason: 'ACTION_OUTCOME_UNKNOWN' }));
        this.transitionTo(row, 'paused', {
          errorJsonRaw: JSON.stringify({ code: 'ACTION_OUTCOME_UNKNOWN', message: e.message, retryable: false }),
          resultsJson: JSON.stringify(results),
          metricsJson: JSON.stringify(metrics),
        }, 'needs_input');
      } else {
        const jev = e as JevError;
        const code = jev.code ?? 'INTERNAL';
        this.transitionTo(row, 'failed', {
          errorJsonRaw: JSON.stringify({ code, message: (e as Error).message.slice(0, 400), retryable: jev.retryable ?? false }),
          resultsJson: JSON.stringify(results),
          metricsJson: JSON.stringify(metrics),
        });
      }
    } finally {
      this.running.delete(taskId);
      const final = this.store.getTask(taskId)!;
      if (isTerminalStatus(final.status as TaskStatus)) {
        this.store.kvDel(`reserve:${pk}`);
      } else if (final.status === 'paused') {
        this.store.kvSet(`reserve:${pk}`, JSON.stringify({ taskId, state: 'paused', at: Date.now() }));
      }
      metrics.runningMs = (metrics.runningMs ?? 0) + (this.clock.now() - startedAt);
      this.resolveWaiter(taskId);
    }
  }

  private makeGate(taskId: string, getPageUrl: () => string) {
    return async (step: import('./types.js').ActionStep): Promise<{ acceptDialogOnce?: boolean } | undefined> => {
      const decision = this.policy.decide({
        action: step.action,
        target: step.target,
        pageUrl: getPageUrl(),
        navigateTo: step.action === 'navigate' ? String(step.value ?? '') : undefined,
      });
      if (decision.allow) return {};
      if (decision.code === 'NEEDS_CONFIRMATION') {
        const actionRevision = this.store.maxActionSeq(taskId) + 1;
        const grant = this.store.findGrant(taskId, actionRevision);
        if (grant) {
          const key = process.env.JEV_BROWSER_APPROVAL_KEY;
          if (!key) throw err('GRANT_INVALID', '缺少 JEV_BROWSER_APPROVAL_KEY，无法核验审批');
          const payload = verifyGrant(grant.token, key, { taskId });
          if (payload.actionRevision !== actionRevision) {
            throw err('GRANT_INVALID', `grant 绑定的 actionRevision 不匹配`);
          }
          if (this.store.consumeGrant(grant.grantId)) {
            return { acceptDialogOnce: false };
          }
        }
        throw new PauseSignal('needs_confirmation', `动作需要人工确认: ${decision.reason}`, {
          pendingApproval: {
            actionRevision,
            action: step.action,
            targetName: step.target && 'name' in step.target ? step.target.name : undefined,
            reason: decision.reason,
          },
        } as Record<string, unknown>);
      }
      throw err(decision.code, decision.reason);
    };
  }

  // ------------------------------------------------------------------
  // 查询 / 取消 / 恢复 / 审批
  // ------------------------------------------------------------------

  getTask(principal: string, taskId: string): TaskEnvelope {
    const row = this.store.getTask(taskId);
    if (!row || row.principal !== principal) throw err('NOT_FOUND', `任务不存在: ${taskId}`);
    return this.envelope(row);
  }

  /** 只读快照（browser_snapshot）：不建任务、不写库，受 origin/modelOrigins 约束。 */
  async snapshot(principal: string, sessionId: string, opts: { forModel?: boolean } = {}): Promise<unknown> {
    const s = this.requireSession(principal, sessionId);
    const page = this.sessionPages.get(sessionId);
    if (!page) throw err('SESSION_NOT_READY', '会话没有可用页面');
    const allowed: string[] = JSON.parse(s.allowedJson);
    const obs = await observePage(page, { allowedOrigins: allowed });
    if (opts.forModel) {
      const modelOrigins: string[] = JSON.parse(s.modelJson);
      if (modelOrigins.length > 0 && !modelOrigins.includes(originOf(obs.url))) {
        throw err('ORIGIN_NOT_ALLOWED', `当前页 origin 不在 modelOrigins 内: ${originOf(obs.url)}`);
      }
    }
    return obs;
  }

  async cancelTask(principal: string, taskId: string, opts: CancelOptions): Promise<TaskEnvelope> {
    const row = this.requireTask(principal, taskId);
    const replay = this.store.findIdempotent(`cancel:${taskId}:${opts.requestId}`);
    if (replay) return this.envelope(this.store.getTask(replay.taskId)!);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision) {
      throw err('REVISION_CONFLICT', `revision 冲突: 期望 ${opts.expectedRevision}，实际 ${row.revision}`);
    }
    const status = row.status as TaskStatus;
    if (isTerminalStatus(status)) {
      this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256('terminal'), taskId);
      return this.envelope(this.store.getTask(taskId)!);
    }
    const runningCtx = this.running.get(taskId);
    if (status === 'running' && runningCtx) {
      runningCtx.stopReason = 'user_cancel';
      runningCtx.cancelFlag.cancelled = true;
      this.store.transition(taskId, row.revision, { status: 'cancelling' });
      this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256('cancelling'), taskId);
      return this.envelope(this.store.getTask(taskId)!);
    }
    if (status === 'cancelling') {
      return this.envelope(this.store.getTask(taskId)!);
    }
    const pk = this.profileKey();
    const target: TaskStatus = status === 'queued' ? 'cancelled' : 'cancelled';
    this.store.transition(taskId, row.revision, { status: target });
    if (status === 'paused') this.store.kvDel(`reserve:${pk}`);
    this.store.putIdempotent(`cancel:${taskId}:${opts.requestId}`, sha256(target), taskId);
    this.resolveWaiter(taskId);
    return this.envelope(this.store.getTask(taskId)!);
  }

  async resumeTask(principal: string, taskId: string, opts: ResumeOptions): Promise<TaskEnvelope> {
    const row = this.requireTask(principal, taskId);
    const replay = this.store.findIdempotent(`resume:${taskId}:${opts.requestId}`);
    if (replay) return this.envelope(this.store.getTask(replay.taskId)!);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== row.revision) {
      throw err('REVISION_CONFLICT', `revision 冲突: 期望 ${opts.expectedRevision}，实际 ${row.revision}`);
    }
    if (row.status !== 'paused') {
      throw err('TASK_NOT_RESUMABLE', `任务状态 ${row.status} 不可恢复（仅 paused 可恢复）`);
    }
    const errInfo = row.errorJson ? (JSON.parse(row.errorJson) as { code?: string; message?: string }) : null;
    const needsConfirm = row.pauseReason === 'needs_confirmation';
    const needsRerunConfirm = ['ambiguous', 'interrupted', 'needs_input'].includes(row.pauseReason ?? '') &&
      (errInfo?.code === 'ACTION_OUTCOME_UNKNOWN' || row.mode !== 'act');
    if (needsConfirm) {
      const actionRevision = errInfo ? (JSON.parse(row.errorJson!) as { pendingApproval?: PendingApproval }).pendingApproval?.actionRevision : undefined;
      const grant = actionRevision !== undefined ? this.store.findGrant(taskId, actionRevision) : undefined;
      if (!grant) {
        throw err('NEEDS_CONFIRMATION', `任务等待审批（actionRevision=${actionRevision}）；请先签发 grant 并调用 approve`);
      }
    } else if (needsRerunConfirm && !opts.rerunConfirmed) {
      throw err('TASK_NOT_RESUMABLE', '该暂停涉及未证实结果或人工核验，需要显式 rerunConfirmed=true');
    }
    // 页面重绑定（重启/断开后）：重新选页并核验
    if (!this.sessionPages.has(row.sessionId)) {
      const session = this.store.getSession(row.sessionId);
      if (session && session.status !== 'disconnected') {
        try {
          await this.ensureBrowser();
          const context = (await this.ensureBrowser()).browser.contexts()[0];
          const sel = await selectPage(context, session.pageId ?? undefined);
          if (sel.page) this.sessionPages.set(row.sessionId, sel.page);
        } catch {
          // 保持暂停：resume 后 runTask 会转 needs_input
        }
      }
    }
    this.store.transition(taskId, row.revision, { status: 'queued' });
    this.store.putIdempotent(`resume:${taskId}:${opts.requestId}`, sha256('queued'), taskId);
    const pk = this.profileKey();
    const prev = this.queues.get(pk) ?? Promise.resolve();
    this.queues.set(pk, prev.then(() => this.runTask(taskId)).catch(() => undefined));
    return this.envelope(this.store.getTask(taskId)!);
  }

  approveTask(principal: string, taskId: string, token: string): TaskEnvelope {
    const row = this.requireTask(principal, taskId);
    const key = process.env.JEV_BROWSER_APPROVAL_KEY;
    if (!key) throw err('GRANT_INVALID', '缺少 JEV_BROWSER_APPROVAL_KEY（独立签发凭据，不注入执行 Agent）');
    const payload = verifyGrant(token, key, { taskId });
    this.store.putGrant({
      grantId: payload.grantId,
      taskId,
      actionRevision: payload.actionRevision,
      token,
      expiresAt: payload.expiresAt,
    });
    return this.envelope(this.store.getTask(taskId)!);
  }

  artifactPath(principal: string, taskId: string, artifactId: string): { path: string; filename: string } {
    const row = this.requireTask(principal, taskId);
    void row;
    const art = this.store.getArtifact(artifactId);
    if (!art || art.taskId !== taskId) throw err('ARTIFACT_NOT_FOUND', `artifact 不存在: ${artifactId}`);
    return { path: art.path, filename: art.filename };
  }

  // ------------------------------------------------------------------
  // 崩溃恢复 / 关闭
  // ------------------------------------------------------------------

  recoverOnStartup(): { recovered: number; isolated: boolean } {
    let recovered = 0;
    const unresolved = this.store.unresolvedActions();
    for (const a of new Set(unresolved.map((u) => u.taskId))) {
      this.store.setActionState(a, this.store.maxActionSeq(a), 'unknown', undefined, JSON.stringify({ reason: 'host_crash' }));
    }
    if (unresolved.length > 0) {
      this.store.kvSet(`isolation:${this.profileKey()}`, JSON.stringify({ taskId: unresolved[0].taskId, at: Date.now(), reason: 'host_crash' }));
    }
    for (const row of this.store.listStale(['queued', 'running', 'cancelling', 'paused'])) {
      const deadlinePassed = row.deadlineAt !== null && this.clock.now() > row.deadlineAt;
      const target = recoverStale(row.status as TaskStatus, deadlinePassed);
      if (target.status !== row.status || target.pauseReason) {
        this.store.transition(taskId0(row), row.revision, {
          status: target.status,
          pauseReason: target.pauseReason ?? row.pauseReason,
        });
        recovered += 1;
      }
    }
    for (const s of this.store.listSessionsByStatus('ready')) {
      // 会话页面绑定随宿主进程丢失
      this.store.upsertSession({ ...s, status: 'disconnected' });
    }
    return { recovered, isolated: unresolved.length > 0 };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.port.close().catch(() => undefined);
      this.browser = null;
    }
    this.store.kvDel(`lock:${this.profileKey()}`);
  }

  // ------------------------------------------------------------------
  // 内部工具
  // ------------------------------------------------------------------

  private requireSession(principal: string, sessionId: string) {
    const s = this.store.getSession(sessionId);
    if (!s || s.principal !== principal) throw err('NOT_FOUND', `会话不存在: ${sessionId}`);
    return s;
  }

  private requireTask(principal: string, taskId: string): TaskRow {
    const row = this.store.getTask(taskId);
    if (!row || row.principal !== principal) throw err('NOT_FOUND', `任务不存在: ${taskId}`);
    return row;
  }

  private requirePage(sessionId: string): PagePort {
    const page = this.sessionPages.get(sessionId);
    if (!page) throw err('SESSION_NOT_READY', '会话没有可用页面（重启/断开后需重新 select-page 并 resume）');
    const closed = (page as unknown as { isClosed?: () => boolean }).isClosed?.() ?? false;
    if (closed) throw err('SESSION_NOT_READY', '会话页面已关闭，需重新 select-page 并 resume');
    return page;
  }

  private transitionTo(row: TaskRow, status: TaskStatus, patch: { error?: { code: string; message: string; retryable?: boolean }; errorJsonRaw?: string; resultsJson?: string; metricsJson?: string; pauseReason?: string; goalJson?: string; varsJson?: string; cursor?: number } = {}, pauseReason?: PauseReason): boolean {
    const ok = this.store.transition(row.taskId, row.revision, {
      status,
      pauseReason: status === 'paused' ? pauseReason ?? row.pauseReason : null,
      errorJson: patch.errorJsonRaw ?? (patch.error ? JSON.stringify(patch.error) : row.errorJson),
      resultsJson: patch.resultsJson,
      metricsJson: patch.metricsJson,
      goalJson: patch.goalJson,
      varsJson: patch.varsJson,
      cursor: patch.cursor,
    }) === 1;
    if (ok && (isTerminalStatus(status) || status === 'paused')) this.resolveWaiter(row.taskId);
    return ok;
  }

  private resolveWaiter(taskId: string): void {
    const w = this.waiters.get(taskId);
    if (w) {
      this.waiters.delete(taskId);
      const row = this.store.getTask(taskId);
      if (row) w(this.envelope(row));
    }
  }

  envelope(row: TaskRow): TaskEnvelope {
    const error = row.errorJson ? (JSON.parse(row.errorJson) as TaskEnvelope['error'] & { pendingApproval?: PendingApproval }) : undefined;
    const env: TaskEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      taskId: row.taskId,
      sessionId: row.sessionId,
      mode: row.mode as TaskEnvelope['mode'],
      revision: row.revision,
      status: row.status as TaskStatus,
      pauseReason: (row.pauseReason as TaskEnvelope['pauseReason']) ?? undefined,
      stepResults: JSON.parse(row.resultsJson) as StepResult[],
      metrics: JSON.parse(row.metricsJson),
      artifacts: this.store.listArtifactsByTask(row.taskId).map(({ artifactId, filename, size, sha256: hash }) => ({ artifactId, filename, size, sha256: hash })),
      error: error ? { code: error.code, message: error.message, retryable: error.retryable ?? false } : undefined,
      pendingApproval: error?.pendingApproval,
      goalVerification: row.goalJson ? (JSON.parse(row.goalJson) as TaskEnvelope['goalVerification']) : undefined,
    };
    return env;
  }
}

function taskId0(row: TaskRow): string {
  return row.taskId;
}

function revArg(step: unknown): unknown {
  return step;
}

function isTerminalStatus(s: string): boolean {
  return ['done', 'failed', 'expired', 'cancelled'].includes(s);
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function guessPageId(context: import('./ports.js').ContextPort, page: PagePort): string {
  const idx = context.pages().indexOf(page);
  return idx >= 0 ? `p${idx}` : 'p0';
}

function validateOrigins(allowed: string[], model: string[]): void {
  const re = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i;
  for (const o of allowed) if (!re.test(o)) throw err('INVALID_INPUT', `allowedOrigins 非法: ${o}`);
  for (const o of model) if (!allowed.includes(o)) throw err('INVALID_INPUT', `modelOrigins 必须是 allowedOrigins 子集: ${o}`);
}

const WRITE_ACTIONS = new Set(['navigate', 'click', 'fill', 'select', 'press']);

/** execute 输入校验：白名单 + 写操作必须提供后置条件（DESIGN §8.1）。 */
export function validateExecuteSteps(steps: FlowStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) throw err('INVALID_INPUT', 'steps 不能为空');
  validatePlannedSteps(JSON.parse(JSON.stringify(steps)) as unknown);
  let branchDepth = 0;
  for (const s of steps) {
    if (s.kind === 'action' && WRITE_ACTIONS.has(s.action) && (!s.expect || s.expect.length === 0)) {
      throw err('INVALID_INPUT', `动作 ${s.action}（${s.id}）必须提供 expect 后置条件`);
    }
    if (s.kind === 'branch') {
      branchDepth += 1;
      if (branchDepth > 1) throw err('INVALID_INPUT', 'branch 只允许一层');
    }
  }
}

/** secretRef 解析：从 JEV_BROWSER_SECRET_<NAME> 读取，缺失 → 暂停（DESIGN §6.3）。 */
export function resolveValues(values: Record<string, ValueInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'object' && v !== null && 'secretRef' in v) {
      const name = (v as { secretRef: string }).secretRef.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      const secret = process.env[`JEV_BROWSER_SECRET_${name}`];
      if (!secret) throw new PauseSignal('needs_input', `缺少 secret "${v.secretRef}"（环境变量 JEV_BROWSER_SECRET_${name}）`);
      out[k] = secret;
    } else {
      out[k] = v;
    }
  }
  return out;
}
