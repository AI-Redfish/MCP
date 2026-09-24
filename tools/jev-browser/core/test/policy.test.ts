import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyGate, originOf } from '../src/policy.js';
import { defaultConfig, type JevBrowserConfig } from '../src/config.js';

function cfg(overrides: Partial<JevBrowserConfig['safety']> = {}): JevBrowserConfig {
  const c = defaultConfig();
  c.safety = { ...c.safety, ...overrides };
  return c;
}

test('originOf 提取 origin', () => {
  assert.equal(originOf('https://example.com/a/b?x=1#f'), 'https://example.com');
});

test('未授权 origin：navigate 被拒', () => {
  const gate = new PolicyGate(cfg({ allowedOrigins: ['https://a.com'] }));
  const d = gate.decide({ action: 'navigate', pageUrl: 'about:blank', navigateTo: 'https://evil.com/' });
  assert.equal(d.allow, false);
  assert.ok(d.allow === false && d.code === 'ORIGIN_NOT_ALLOWED');
});

test('预授权动作 + 非风险目标：放行', () => {
  const gate = new PolicyGate(cfg({ allowedOrigins: ['https://example.com'] }));
  const d = gate.decide({
    action: 'click',
    target: { by: 'role', role: 'button', name: '排序' },
    pageUrl: 'https://example.com/list',
  });
  assert.deepEqual(d, { allow: true });
});

test('目标名命中高风险 pattern：需要确认（尽力而为启发式）', () => {
  const gate = new PolicyGate(cfg({ allowedOrigins: ['https://example.com'] }));
  const d = gate.decide({
    action: 'click',
    target: { by: 'role', role: 'button', name: '确认支付' },
    pageUrl: 'https://example.com/checkout',
  });
  assert.ok(d.allow === false && d.code === 'NEEDS_CONFIRMATION');
});

test('动作不在预授权名单：需要确认', () => {
  const gate = new PolicyGate(cfg({ allowedOrigins: ['https://example.com'], preauthorizedActions: ['navigate'] }));
  const d = gate.decide({ action: 'click', target: { by: 'role', role: 'button', name: '排序' }, pageUrl: 'https://example.com/' });
  assert.ok(d.allow === false && d.code === 'NEEDS_CONFIRMATION');
});
