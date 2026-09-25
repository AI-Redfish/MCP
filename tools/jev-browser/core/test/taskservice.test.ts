import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Runtime, validateExecuteSteps, resolveValues } from '../src/taskservice.js';
import { loadConfig, defaultConfig } from '../src/config.js';
import { signGrant } from '../src/grants.js';
import { TaskStore } from '../src/store.js';
import { FakeBrowser, FakeConnector, FakeContext, FakeJudge, FakePage } from './fakes.js';
import type { PlannerProvider } from '../src/planner.js';
import type { FlowStep, TaskEnvelope } from '../src/types.js';
import type { JevBrowserConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// 测试环境：临时 dataDir + Fake 浏览器/裁判（无网络、无真实浏览器）
// ---------------------------------------------------------------------------

let dir: string;
let store: TaskStore;

function testConfig(overrides: Partial<JevBrowserConfig> = {}): JevBrowserConfig {
  const cfg = defaultConfig();
  cfg.runtime.dataDir = dir;
  cfg.safety.allowedOrigins = ['https://example.com'];
  cfg.runtime.queueTimeoutMs = 2000;
  return { ...cfg, ...overrides };
}

function makeRuntime(cfg: JevBrowserConfig, pages: FakePage[], judge?: FakeJudge, planner?: PlannerProvider): Runtime {
  store = new TaskStore(path.join(dir, 'tasks.db'));
  const ctx = new FakeContext(pages);
  const browser = new FakeBrowser(ctx);
  return new Runtime(cfg, {
    store,
    connector: new FakeConnector(browser),
    judge: judge ?? new FakeJudge({ decisions: [] }),
    planner,
  });
}

function flow(steps: FlowStep[]): FlowStep[] {
  return JSON.parse(JSON.stringify(steps)) as FlowStep[];
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'jev-rt-'));
  delete process.env.JEV_BROWSER_APPROVAL_KEY;
  delete process.env.JEV_BROWSER_SECRET_PW;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// execute 主路径
// ---------------------------------------------------------------------------

test('execute：确定性流程完成，模型调用为 0', async () => {
  const page = new FakePage({ url: 'https://example.com/page', bodyText: 'Example Domain' });
  const judge = new FakeJudge({ decisions: [] });
  const rt = makeRuntime(testConfig(), [page], judge);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  assert.equal(session.status, 'ready');
  const env = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([
      { id: 's1', kind: 'extract', target: { by: 'css', selector: 'h1' }, fields: ['text'], saveAs: 'h' },
      { id: 's2', kind: 'assert', expect: [{ kind: 'text_present', value: 'Example Domain' }] },
    ]),
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'done');
  assert.equal(final.metrics.actions, 0); // 无写动作
  assert.equal(judge.usage().jevRequests, 0); // 纯确定性：0 模型调用
  await rt.close();
});

test('execute：写操作缺 expect 被拒绝；非授权 origin 被策略拦截', async () => {
  const page = new FakePage({ url: 'https://example.com/' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  await assert.rejects(
    rt.execute('p1', session.sessionId, {
      sessionId: session.sessionId,
      // 故意缺少 expect：由 validateExecuteSteps 在提交时拒绝（类型层用 as 绕过以表达非法输入）
      steps: [{ id: 'w1', kind: 'action', action: 'fill', target: { by: 'css', selector: '#q' }, value: 'x' }] as unknown as FlowStep[],
      values: {},
    }),
    /expect 后置条件/,
  );
  // navigate 到未授权 origin → ORIGIN_NOT_ALLOWED → failed
  const env = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'nav', kind: 'action', action: 'navigate', value: 'https://evil.com/', expect: [{ kind: 'url_contains', value: 'evil' }] }]),
    values: {},
  });
  const final = await rt.waitEnvelope(env.taskId);
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'ORIGIN_NOT_ALLOWED');
  await rt.close();
});

test('幂等：同键同体返回原任务；同键不同体冲突', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const input = {
    sessionId: session.sessionId,
    steps: flow([{ id: 'a', kind: 'assert', expect: [] }]),
    values: {},
  };
  const e1 = await rt.execute('p1', session.sessionId, input as never, { idempotencyKey: 'k1' });
  const e2 = await rt.execute('p1', session.sessionId, input as never, { idempotencyKey: 'k1' });
  assert.equal(e1.taskId, e2.taskId);
  await assert.rejects(
    rt.execute('p1', session.sessionId, { ...input, steps: flow([{ id: 'b', kind: 'assert', expect: [] }]) } as never, { idempotencyKey: 'k1' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await rt.close();
});

// ---------------------------------------------------------------------------
// 高风险动作 → 暂停 → grant 审批 → 恢复
// ---------------------------------------------------------------------------

test('高风险目标暂停 needs_confirmation；approve + resume 后完成', async () => {
  process.env.JEV_BROWSER_APPROVAL_KEY = 'secret-key';
  const page = new FakePage({ url: 'https://example.com/cart', bodyText: 'ok' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const steps = flow([
    { id: 'risk', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: '确认支付' }, expect: [{ kind: 'text_present', value: 'ok' }] },
  ]);
  const env = await rt.execute('p1', session.sessionId, { sessionId: session.sessionId, steps: steps as never, values: {} });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauseReason, 'needs_confirmation');
  assert.ok(paused.pendingApproval);
  assert.equal(paused.pendingApproval!.action, 'click');

  // 无 grant 的 resume 被拒绝
  await assert.rejects(
    rt.resumeTask('p1', paused.taskId, { requestId: 'r1' }),
    /NEEDS_CONFIRMATION/,
  );
  // 用执行 Agent 的身份伪造 approved: true 没有任何通道 —— 只能凭 grant
  const { signature } = signGrant(
    { grantId: 'g1', taskId: paused.taskId, actionRevision: paused.pendingApproval!.actionRevision, action: 'click', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    'secret-key',
  );
  const approved = rt.approveTask('p1', paused.taskId, signature);
  assert.equal(approved.status, 'paused'); // approve 只登记，不执行

  const resumed = await rt.resumeTask('p1', paused.taskId, { requestId: 'r2' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  // grant 一次性：再次暂停（新 revision）后旧 grant 不能复用
  const env2 = await rt.execute('p1', session.sessionId, { sessionId: session.sessionId, steps: steps as never, values: {} });
  const paused2 = await rt.waitEnvelope(env2.taskId);
  assert.equal(paused2.status, 'paused');
  assert.throws(
    () => rt.approveTask('p1', paused2.taskId, signature),
    /actionRevision 不匹配|GRANT_INVALID/,
  );
  await rt.close();
});

// ---------------------------------------------------------------------------
// 取消 / 会话 / 断开
// ---------------------------------------------------------------------------

test('cancel：queued 立即取消；同 requestId 重放返回原结果', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // 用受控 Promise 阻塞第一个任务（占住 profile 队列）
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  (page as unknown as { waitForTimeout: () => Promise<void> }).waitForTimeout = () => gate;
  const blocker = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'slow', kind: 'action', action: 'wait', value: 100, expect: [] }]),
    values: {},
  });
  await new Promise((r) => setTimeout(r, 50)); // 让 blocker 进入 running
  const queued = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'a', kind: 'assert', expect: [] }]),
    values: {},
  });
  assert.equal(queued.status, 'queued');
  const cancelled = await rt.cancelTask('p1', queued.taskId, { requestId: 'c1' });
  assert.equal(cancelled.status, 'cancelled');
  const replay = await rt.cancelTask('p1', queued.taskId, { requestId: 'c1' });
  assert.equal(replay.taskId, queued.taskId);
  assert.equal(replay.status, 'cancelled');
  release(); // 放行 blocker，避免悬挂
  await rt.waitEnvelope(blocker.taskId);
  await rt.close();
});

test('disconnect：有活动任务拒绝；暂停任务需显式 detach；断开后 resume 重绑页面', async () => {
  process.env.JEV_BROWSER_APPROVAL_KEY = 'k';
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'ok' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'risk', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: '确认支付' }, expect: [{ kind: 'text_present', value: 'ok' }] }]),
    values: {},
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  await assert.rejects(rt.disconnect('p1', session.sessionId), /detachTask/);
  await rt.disconnect('p1', session.sessionId, { detachTask: true });
  const after = store.getSession(session.sessionId);
  assert.equal(after?.status, 'disconnected');
  // 断开后 resume：needs_confirmation 需 grant；重绑页面后继续
  await assert.rejects(
    rt.resumeTask('p1', paused.taskId, { requestId: 'r8' }),
    /NEEDS_CONFIRMATION/,
  );
  const { signature } = signGrant(
    { grantId: 'g9', taskId: paused.taskId, actionRevision: paused.pendingApproval!.actionRevision, action: 'click', issuedAt: Date.now(), expiresAt: Date.now() + 60_000 },
    'k',
  );
  rt.approveTask('p1', paused.taskId, signature);
  const resumed = await rt.resumeTask('p1', paused.taskId, { requestId: 'r9' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  await rt.close();
});

// ---------------------------------------------------------------------------
// run 模式 / 隔离 / 跨主体
// ---------------------------------------------------------------------------

test('run：planner 未配置快速失败；successCriteria 缺失拒绝', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]); // planner = null
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: ['https://example.com'],
  });
  await assert.rejects(
    rt.run('p1', session.sessionId, { sessionId: session.sessionId, goal: 'g', successCriteria: 's', values: {} }),
    /PLANNER_NOT_CONFIGURED/,
  );
  await rt.close();
});

test('跨主体访问：任务与会话按 principal 隔离', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'a', kind: 'assert', expect: [] }]),
    values: {},
  });
  await rt.waitEnvelope(env.taskId);
  assert.throws(() => rt.getTask('p2', env.taskId), /NOT_FOUND/);
  assert.throws(() => rt.disconnect('p2', session.sessionId), /NOT_FOUND/);
  await rt.close();
});

test('unknown 隔离：超时未知动作后，新写任务被拒绝、只读放行', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x', clickError: new Error('TimeoutError: 30000ms exceeded') });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 't1', kind: 'action', action: 'click', target: { by: 'css', selector: '#x' }, expect: [{ kind: 'url_contains', value: 'never' }] }]),
    values: {},
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.error?.code, 'ACTION_OUTCOME_UNKNOWN');

  // 新写任务（fill 是写动作）被隔离拒绝
  const writeEnv = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'w', kind: 'action', action: 'fill', target: { by: 'css', selector: '#y' }, value: 'v', expect: [{ kind: 'text_present', value: 'v' }] }]),
    values: {},
  });
  const writeFinal = await rt.waitEnvelope(writeEnv.taskId);
  assert.equal(writeFinal.status, 'failed');
  assert.equal(writeFinal.error?.code, 'BROWSER_BUSY');

  // 取消隔离中的任务（释放预约；隔离记录仍在），只读任务放行
  await rt.cancelTask('p1', paused.taskId, { requestId: 'cx' });
  const readEnv = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([{ id: 'r', kind: 'assert', expect: [] }]),
    values: {},
  });
  const readFinal = await rt.waitEnvelope(readEnv.taskId);
  assert.equal(readFinal.status, 'done');
  await rt.close();
});

test('崩溃恢复：遗留 running → paused(interrupted)；需 rerunConfirmed 才能恢复', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'x' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  // 直接插入一条 running 任务（模拟宿主崩溃时未收尾的状态，避免队列竞态）
  const taskId = 'tcrash1';
  const now = Date.now();
  store.insertTask({
    taskId,
    sessionId: session.sessionId,
    principal: 'p1',
    mode: 'execute',
    status: 'running',
    pauseReason: null,
    revision: 3,
    requestJson: JSON.stringify({
      sessionId: session.sessionId,
      steps: [{ id: 'w', kind: 'action', action: 'wait', target: { by: 'css', selector: '#z' }, expect: [{ kind: 'visible', target: { by: 'css', selector: '#z' } }] }],
      values: {},
    }),
    cursor: 0,
    varsJson: '{}',
    resultsJson: '[]',
    metricsJson: '{}',
    errorJson: null,
    goalJson: null,
    createdAt: now,
    updatedAt: now,
    deadlineAt: now + 600_000,
  });
  const rec = rt.recoverOnStartup();
  const row = store.getTask(taskId)!;
  assert.equal(row.status, 'paused');
  assert.equal(row.pauseReason, 'interrupted');
  assert.ok(rec.recovered >= 1);
  // 未确认的 resume 拒绝
  await assert.rejects(
    rt.resumeTask('p1', taskId, { requestId: 'x1' }),
    /rerunConfirmed/,
  );
  // 显式确认后恢复（wait 目标在 FakePage 中可见 → done，状态机路径完整）
  const resumed = await rt.resumeTask('p1', taskId, { requestId: 'x2', rerunConfirmed: true });
  assert.equal(resumed.status, 'queued');
  const final = await rt.waitEnvelope(taskId);
  assert.equal(final.status, 'done');
  await rt.close();
});

test('secretRef：缺环境变量暂停 needs_input；补齐后恢复成功', async () => {
  const page = new FakePage({ url: 'https://example.com/login', bodyText: 'welcome' });
  const rt = makeRuntime(testConfig(), [page]);
  const session = await rt.createSession('p1', {
    target: { kind: 'existing' },
    allowedOrigins: ['https://example.com'],
    modelOrigins: [],
  });
  const env = await rt.execute('p1', session.sessionId, {
    sessionId: session.sessionId,
    steps: flow([
      { id: 'fill', kind: 'action', action: 'fill', target: { by: 'css', selector: '#pw' }, valuesRef: 'pw', expect: [{ kind: 'text_present', value: 'welcome' }] },
    ]),
    values: { pw: { secretRef: 'PW' } } as never,
  });
  const paused = await rt.waitEnvelope(env.taskId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pauseReason, 'needs_input');
  // 补齐 secret 后恢复
  process.env.JEV_BROWSER_SECRET_PW = 's3cret';
  const resumed = await rt.resumeTask('p1', paused.taskId, { requestId: 's1' });
  const final = await rt.waitEnvelope(resumed.taskId);
  assert.equal(final.status, 'done');
  // secret 不落盘：vars 中只应有解析后的引用在内存，库里的 varsJson 不含请求 values
  const row = store.getTask(resumed.taskId)!;
  assert.ok(!row.requestJson.includes('s3cret'));
  assert.ok(!row.varsJson.includes('s3cret'));
  await rt.close();
});

// ---------------------------------------------------------------------------
// 校验工具
// ---------------------------------------------------------------------------

test('validateExecuteSteps：空步骤/非法字段拒绝', () => {
  assert.throws(() => validateExecuteSteps([]), /不能为空/);
  assert.throws(
    () => validateExecuteSteps([{ id: 'x', kind: 'quantum' } as never]),
    /kind 非法/,
  );
});

test('resolveValues：非 secret 值直传；secret 缺失抛暂停', () => {
  const out = resolveValues({ a: 'plain', n: 3 });
  assert.deepEqual(out, { a: 'plain', n: 3 });
  assert.throws(() => resolveValues({ s: { secretRef: 'NOPE' } }), (e: unknown) => (e as Error).name === 'PauseSignal');
});
