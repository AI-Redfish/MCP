import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlannedSteps, WRITE_ACTIONS } from '../src/planner.js';
import type { FlowStep } from '../src/types.js';

test('写操作必须带 expect；观察动作可省略', () => {
  const steps: unknown[] = [
    { id: 'a1', kind: 'action', action: 'click', target: { by: 'role', role: 'button', name: 'go' }, expect: [{ kind: 'url_contains', value: '/done' }] },
    { id: 'a2', kind: 'action', action: 'screenshot' },
    { id: 'a3', kind: 'action', action: 'wait', value: 500 },
  ];
  const out = validatePlannedSteps(steps);
  assert.equal(out.length, 3);
  assert.ok(WRITE_ACTIONS.has('click'));
  assert.ok(!WRITE_ACTIONS.has('screenshot'));

  assert.throws(
    () => validatePlannedSteps([{ id: 'x', kind: 'action', action: 'fill', target: { by: 'css', selector: '#a' } }]),
    /缺少 expect 后置条件/,
  );
});

test('navigate 必须有 value 或 valuesRef；非法 action/locator 拒绝', () => {
  assert.throws(
    () => validatePlannedSteps([{ id: 'n1', kind: 'action', action: 'navigate', expect: [{ kind: 'url_contains', value: 'x' }] }]),
    /navigate 需要 value/,
  );
  assert.throws(
    () => validatePlannedSteps([{ id: 'n2', kind: 'action', action: 'hack', expect: [] }]),
    /action 非法/,
  );
  assert.throws(
    () => validatePlannedSteps([{ id: 'n3', kind: 'action', action: 'click', target: { by: 'xpath', query: '//' }, expect: [{ kind: 'visible' }] }]),
    /by 非法/,
  );
});

test('branch/forEach 不允许嵌套；forEach.maxItems 有界', () => {
  assert.throws(
    () => validatePlannedSteps([
      { id: 'b1', kind: 'branch', variable: 'v', equals: 'x', then: [{ id: 'b2', kind: 'branch', variable: 'w', equals: 1, then: [] }] },
    ]),
    /branch 不允许嵌套/,
  );
  assert.throws(
    () => validatePlannedSteps([
      { id: 'f1', kind: 'forEach', itemsVar: 'items', itemVar: 'item', maxItems: 99, body: [] },
    ]),
    /maxItems/,
  );
  assert.throws(
    () => validatePlannedSteps([
      { id: 'f2', kind: 'forEach', itemsVar: 'items', itemVar: 'item', maxItems: 5, body: [{ id: 'f3', kind: 'forEach', itemsVar: 'a', itemVar: 'b', maxItems: 5, body: [] }] },
    ]),
    /forEach 不允许嵌套/,
  );
});

test('goal 步骤与空计划；步骤数上限', () => {
  const out = validatePlannedSteps([
    { id: 'g1', kind: 'goal', goal: '找到搜索框并输入', expect: [{ kind: 'text_present', value: 'ok' }] },
  ]) as FlowStep[];
  assert.equal(out[0]!.kind, 'goal');
  assert.equal(validatePlannedSteps([]).length, 0);
  const tooMany = Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, kind: 'assert', expect: [] }));
  assert.throws(() => validatePlannedSteps(tooMany), /超过上限/);
});
