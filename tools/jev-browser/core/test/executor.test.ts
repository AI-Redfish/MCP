import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performAction, FsArtifactSink } from '../src/executor.js';
import { ActionOutcomeUnknownError } from '../src/errors.js';
import { FakePage } from './fakes.js';
import type { ActionStep } from '../src/types.js';

/** 可读取记录的执行上下文工厂。 */
function makeRecordingCtx(values: Record<string, unknown> = {}) {
  const entries: Array<{ rev: number; state: string }> = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-exec-'));
  const ctx: Parameters<typeof performAction>[2] = {
    vars: {} as Record<string, unknown>,
    values,
    artifacts: new FsArtifactSink(dir),
    ledger: {
      prepared: (_s, rev) => entries.push({ rev, state: 'prepared' }),
      inFlight: (_s, rev) => entries.push({ rev, state: 'in_flight' }),
      finished: (_s, rev, state) => entries.push({ rev, state }),
    },
    actionRevision: 7,
    actionTimeoutMs: 2000,
    cancelFlag: { cancelled: false },
  };
  return { ctx, entries, dir };
}

test('账本三态收口：成功 verified / 断言失败 failed / 超时 unknown', async () => {
  // 成功
  {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example' });
    const { ctx, entries } = makeRecordingCtx();
    await performAction(page, {
      id: 's1', kind: 'action', action: 'navigate', value: 'https://example.com/x',
      expect: [{ kind: 'url_contains', value: 'example.com' }],
    }, ctx);
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'verified']);
  }
  // 后置条件失败 → failed
  {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example' });
    const { ctx, entries } = makeRecordingCtx();
    await assert.rejects(
      performAction(page, {
        id: 's2', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: 'x' },
        expect: [{ kind: 'url_contains', value: 'other.com' }],
      }, ctx),
      /ACTION_FAILED/,
    );
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'failed']);
  }
  // 超时且无法证实 → unknown + ActionOutcomeUnknownError
  {
    const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example', clickError: new Error('TimeoutError: 30000ms exceeded') });
    const { ctx, entries } = makeRecordingCtx();
    await assert.rejects(
      performAction(page, {
        id: 's3', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: 'x' },
        expect: [{ kind: 'url_contains', value: 'never' }],
      }, ctx),
      (e: unknown) => e instanceof ActionOutcomeUnknownError,
    );
    assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'unknown']);
  }
});

test('下载动作：saveAs 到受管 artifact 区，临时文件清理，变量落盘', async () => {
  const page = new FakePage({ url: 'https://example.com/', bodyText: 'Example', downloadAfterClick: { filename: 'report.csv', content: 'id,name\n1,a' } });
  const { ctx, entries, dir } = makeRecordingCtx();
  const step: ActionStep = {
    id: 'd1', kind: 'action', action: 'click',
    target: { by: 'role', role: 'link', name: 'download' },
    expect: [{ kind: 'download_completed', variable: 'file' }],
  };
  const out = await performAction(page, step, ctx);
  assert.ok(out.artifactId);
  assert.equal(ctx.vars['file'], out.artifactId);
  const saved = readdirSync(dir).filter((f) => !f.startsWith('.tmp-'));
  assert.equal(saved.length, 1);
  assert.ok(saved[0]!.includes('report.csv'));
  assert.ok(!existsSync(path.join(dir, '.tmp-0')));
  assert.deepEqual(entries.map((e) => e.state), ['prepared', 'in_flight', 'verified']);
  assert.equal(readFileSync(path.join(dir, saved[0]!), 'utf8'), 'id,name\n1,a');
});

test('navigate 缺 value：INVALID_INPUT，不进入 prepared', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx();
  await assert.rejects(
    performAction(page, { id: 'n1', kind: 'action', action: 'navigate', expect: [{ kind: 'url_contains', value: 'x' }] }, ctx),
    /navigate/,
  );
  assert.deepEqual(entries, []);
});

test('取消旗标：动作不派发、无账本写入', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx();
  ctx.cancelFlag!.cancelled = true;
  await assert.rejects(
    performAction(page, {
      id: 'c1', kind: 'action', action: 'click', target: { by: 'css', selector: '#a' },
      expect: [{ kind: 'visible', target: { by: 'css', selector: '#a' } }],
    }, ctx),
    /POLICY_BLOCKED/,
  );
  assert.deepEqual(entries, []);
});

test('valuesRef 引用 secretRef 未解析值时拒绝', async () => {
  const page = new FakePage({});
  const { ctx, entries } = makeRecordingCtx({ token: { secretRef: 'PW' } });
  await assert.rejects(
    performAction(page, {
      id: 'v1', kind: 'action', action: 'fill', target: { by: 'css', selector: '#pw' }, valuesRef: 'token',
      expect: [{ kind: 'visible', target: { by: 'css', selector: '#pw' } }],
    }, ctx),
    /secretRef/,
  );
  assert.deepEqual(entries, []);
});
