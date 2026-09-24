import type { ActionName, LocatorSpec } from './types.js';
import { err } from './errors.js';
import type { JevBrowserConfig } from './config.js';

/**
 * PolicyGate（DESIGN §10）：动作类型 + 目标 + 域 + 参数综合判定。
 * 注意：这是尽力而为的启发式——未知站点不能保证识别所有隐藏副作用，
 * 无法可靠限定的写操作默认要求人工确认（首版高危动作一律暂停）。
 */

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function isOriginAllowed(url: string, allowed: string[]): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return allowed.includes(origin);
}

/** 命中高风险目标名 pattern（目标 name/text 与 pattern 不区分大小写匹配）。 */
export function targetLooksRisky(target: LocatorSpec | undefined, patterns: string[]): string | undefined {
  if (!target) return undefined;
  const names: string[] = [];
  if ('name' in target && target.name) names.push(target.name);
  if ('text' in target && target.text) names.push(target.text);
  const haystack = names.join(' ').toLowerCase();
  for (const p of patterns) {
    if (haystack.includes(p.toLowerCase())) return p;
  }
  return undefined;
}

export type PolicyDecision =
  | { allow: true }
  | { allow: false; code: 'ORIGIN_NOT_ALLOWED' | 'POLICY_BLOCKED' | 'NEEDS_CONFIRMATION'; reason: string };

export interface PolicyInput {
  action: ActionName;
  target?: LocatorSpec;
  /** 动作即将作用的页面 URL。 */
  pageUrl: string;
  /** navigate 的目标 URL。 */
  navigateTo?: string;
}

export class PolicyGate {
  constructor(private readonly cfg: JevBrowserConfig) {}

  decide(input: PolicyInput): PolicyDecision {
    const allowed = this.cfg.safety.allowedOrigins;
    const effectiveUrl = input.action === 'navigate' ? input.navigateTo ?? '' : input.pageUrl;
    if (allowed.length > 0 && !isOriginAllowed(effectiveUrl, allowed)) {
      return { allow: false, code: 'ORIGIN_NOT_ALLOWED', reason: `origin 未授权: ${originOf(effectiveUrl) || effectiveUrl}` };
    }
    if (input.action === 'navigate' && input.navigateTo) {
      let parsed: URL;
      try {
        parsed = new URL(input.navigateTo);
      } catch {
        return { allow: false, code: 'POLICY_BLOCKED', reason: `非法 URL: ${input.navigateTo}` };
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { allow: false, code: 'POLICY_BLOCKED', reason: `只允许 http/https: ${parsed.protocol}` };
      }
    }
    if (!this.cfg.safety.preauthorizedActions.includes(input.action)) {
      return { allow: false, code: 'NEEDS_CONFIRMATION', reason: `动作不在预授权名单: ${input.action}` };
    }
    const risky = targetLooksRisky(input.target, this.cfg.safety.riskyNamePatterns);
    if (risky) {
      return { allow: false, code: 'NEEDS_CONFIRMATION', reason: `目标名命中高风险 pattern "${risky}"（尽力而为的启发式，未授权前不执行）` };
    }
    return { allow: true };
  }
}

/** 断言 URL origin 被授权（观察与外发前调用）。 */
export function assertOriginAllowed(url: string, allowed: string[]): void {
  if (allowed.length > 0 && !isOriginAllowed(url, allowed)) {
    throw err('ORIGIN_NOT_ALLOWED', `当前页 origin 未授权，停止观察与模型外发: ${originOf(url)}`);
  }
}
