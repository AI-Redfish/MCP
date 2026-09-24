import crypto from 'node:crypto';
import { err } from './errors.js';

/**
 * 审批 grant（DESIGN §10）：绑定 taskId + actionRevision + 有效期；一次性消费。
 * 签发依赖独立凭据（JEV_BROWSER_APPROVAL_KEY）——同 OS 用户可读取该密钥时这
 * 不构成对恶意进程的防御边界（威胁模型见 RESEARCH/DESIGN），首版高危动作默认暂停。
 */

export interface GrantPayload {
  grantId: string;
  taskId: string;
  actionRevision: number;
  action: string;
  targetName?: string;
  issuedAt: number;
  expiresAt: number;
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signGrant(payload: GrantPayload, key: string): { payload: GrantPayload; signature: string } {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', key).update(body).digest();
  return { payload, signature: `${b64u(body)}.${b64u(sig)}` };
}

export function verifyGrant(
  token: string,
  key: string,
  opts: { taskId: string; actionRevision?: number; now?: number },
): GrantPayload {
  const dot = token.indexOf('.');
  if (dot <= 0) throw err('GRANT_INVALID', 'grant 格式非法');
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as GrantPayload;
  } catch {
    throw err('GRANT_INVALID', 'grant payload 解析失败');
  }
  const expected = crypto.createHmac('sha256', key).update(Buffer.from(bodyB64, 'base64url')).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sigB64, 'base64url');
  } catch {
    throw err('GRANT_INVALID', 'grant 签名编码非法');
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw err('GRANT_INVALID', 'grant 签名不匹配');
  }
  if (payload.taskId !== opts.taskId) throw err('GRANT_INVALID', `grant 绑定任务不匹配: ${payload.taskId}`);
  if (opts.actionRevision !== undefined && payload.actionRevision !== opts.actionRevision) {
    throw err('GRANT_INVALID', `grant 绑定的 actionRevision 不匹配: ${payload.actionRevision} ≠ ${opts.actionRevision}`);
  }
  const now = opts.now ?? Date.now();
  if (now > payload.expiresAt) throw err('GRANT_INVALID', 'grant 已过期');
  return payload;
}
