import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signGrant, verifyGrant } from '../src/grants.js';
import { recoverStale, resolveCancelling, assertTransition } from '../src/statemachine.js';

test('grant 签发/核验/过期/篡改', () => {
  const key = 'k1';
  const { payload, signature } = signGrant(
    { grantId: 'g1', taskId: 't1', actionRevision: 3, action: 'click', issuedAt: 0, expiresAt: 10_000 },
    key,
  );
  assert.equal(payload.actionRevision, 3);
  const verified = verifyGrant(signature, key, { taskId: 't1', actionRevision: 3, now: 5_000 });
  assert.equal(verified.grantId, 'g1');

  assert.throws(() => verifyGrant(signature, key, { taskId: 't1', now: 20_000 }), /过期/);
  assert.throws(() => verifyGrant(signature, 'other-key', { taskId: 't1' }), /签名不匹配/);
  assert.throws(() => verifyGrant(signature, key, { taskId: 't2' }), /任务不匹配/);
  assert.throws(() => verifyGrant(signature, key, { taskId: 't1', actionRevision: 4 }), /actionRevision 不匹配/);
  assert.throws(() => verifyGrant('bad-token', key, { taskId: 't1' }), /格式非法/);
});

test('状态机：恢复与取消收敛', () => {
  assertTransition('queued', 'running');
  assert.throws(() => assertTransition('done', 'running'), /非法状态转移/);
  assert.equal(resolveCancelling('user_cancel'), 'cancelled');
  assert.equal(resolveCancelling('deadline'), 'expired');
  assert.equal(resolveCancelling('budget'), 'failed');
  assert.deepEqual(recoverStale('running', false), { status: 'paused', pauseReason: 'interrupted' });
  assert.deepEqual(recoverStale('running', true), { status: 'expired' });
  assert.deepEqual(recoverStale('done', false), { status: 'done' });
});
