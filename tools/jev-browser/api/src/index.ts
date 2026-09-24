#!/usr/bin/env node
/**
 * @ai-redfish/jev-browser-api —— HTTP API 适配器（本地长驻宿主）
 *
 * 安全基线（DESIGN §10）：仅 loopback、强制 Bearer token、校验 Host、
 * 不启用 CORS、请求体 1MB 上限。路由契约见 DESIGN §8.3。
 */
import http from 'node:http';
import {
  Runtime,
  SCHEMA_VERSION,
  loadConfig,
  runDoctor,
  validateExecuteSteps,
  type TaskEnvelope,
} from '@ai-redfish/jev-browser-core';
import * as fs from 'node:fs';

interface CliFlags {
  config?: string;
  port?: number;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') flags.config = argv[++i];
    if (argv[i] === '--port') flags.port = Number(argv[++i]);
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const { config } = loadConfig({ file: flags.config });
const token = process.env[config.api.tokenEnv];
if (!token) {
  console.error(`[jev-browser-api] 缺少 API token（环境变量 ${config.api.tokenEnv}）；拒绝启动`);
  process.exit(2);
}

const PRINCIPAL = 'api-host';
const runtime = new Runtime(config);
const recovery = runtime.recoverOnStartup();
console.error(`[jev-browser-api] 崩溃恢复: ${recovery.recovered} 个遗留任务转暂停${recovery.isolated ? '；存在未知在途动作已隔离' : ''}`);

const MAX_BODY = 1024 * 1024;

function send(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 创建 API 服务器（测试可注入 runtime；生产入口 main() 使用真实 runtime）。 */
export function createApiServer(rt: Runtime, opts: { token: string }): http.Server {
  const accessToken = opts.token;
  return http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // Host/Origin 校验：防 DNS rebinding / 浏览器跨站调用（DESIGN §10）
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    return fail(res, 403, 'POLICY_BLOCKED', `非法 Host: ${host}`);
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${accessToken}`) {
    return fail(res, 401, 'GRANT_INVALID', '缺少或不匹配的 Bearer token');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const idem = req.headers['idempotency-key'] as string | undefined;

  try {
    // GET /v1/diagnostics
    if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
      const doctor = await runDoctor({});
      return send(res, 200, { doctor, recovery: { recovered: 0, isolated: false }, schemaVersion: SCHEMA_VERSION });
    }

    // POST /v1/sessions
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = JSON.parse(await readBody(req));
      const session = await runtime.createSession(PRINCIPAL, body);
      return send(res, 201, session);
    }

    // GET /v1/sessions/:id/pages
    if (req.method === 'GET' && parts[1] === 'sessions' && parts[3] === 'pages') {
      return send(res, 200, { pages: await runtime.listPages(PRINCIPAL, parts[2]!) });
    }

    // POST /v1/sessions/:id/page | .../act
    if (req.method === 'POST' && parts[1] === 'sessions' && (parts[3] === 'page' || parts[3] === 'act')) {
      const body = JSON.parse(await readBody(req));
      if (parts[3] === 'page') {
        return send(res, 200, await runtime.selectPage(PRINCIPAL, parts[2]!, String(body.pageId)));
      }
      const queued = await runtime.act(PRINCIPAL, parts[2]!, { sessionId: parts[2]!, step: body.step, values: body.values ?? {} });
      return send(res, 202, queued);
    }

    // POST /v1/tasks/execute | run
    if (req.method === 'POST' && parts[1] === 'tasks' && (parts[2] === 'execute' || parts[2] === 'run')) {
      const body = JSON.parse(await readBody(req));
      const queued = parts[2] === 'execute'
        ? await runtime.execute(PRINCIPAL, String(body.sessionId), body, { idempotencyKey: idem })
        : await runtime.run(PRINCIPAL, String(body.sessionId), body, { idempotencyKey: idem });
      return send(res, 202, queued);
    }

    // GET /v1/tasks/:id
    if (req.method === 'GET' && parts[1] === 'tasks' && parts.length === 3) {
      return send(res, 200, { envelope: runtime.getTask(PRINCIPAL, parts[2]!) });
    }

    // POST /v1/tasks/:id/cancel|resume|approve
    if (req.method === 'POST' && parts[1] === 'tasks' && parts.length === 4 && ['cancel', 'resume', 'approve'].includes(parts[3]!)) {
      const body = parts[3] === 'approve' ? JSON.parse(await readBody(req) || '{}') : JSON.parse(await readBody(req));
      if (parts[3] === 'cancel') return send(res, 200, { envelope: await runtime.cancelTask(PRINCIPAL, parts[2]!, body) });
      if (parts[3] === 'resume') return send(res, 200, { envelope: await runtime.resumeTask(PRINCIPAL, parts[2]!, body) });
      return send(res, 200, { envelope: runtime.approveTask(PRINCIPAL, parts[2]!, String(body.grant)) });
    }

    // GET /v1/tasks/:id/artifacts/:artifactId
    if (req.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts') {
      const { path: filePath, filename } = runtime.artifactPath(PRINCIPAL, parts[2]!, parts[4]!);
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      });
      return res.end(data);
    }

    // DELETE /v1/sessions/:id
    if (req.method === 'DELETE' && parts[1] === 'sessions' && parts.length === 3) {
      const detachTask = url.searchParams.get('detachTask') === 'true';
      return send(res, 200, await runtime.disconnect(PRINCIPAL, parts[2]!, { detachTask }));
    }

    return fail(res, 404, 'NOT_FOUND', `未知路由: ${req.method} ${url.pathname}`);
  } catch (e) {
    const errObj = e as { code?: string; message?: string };
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      IDEMPOTENCY_CONFLICT: 409,
      REVISION_CONFLICT: 409,
      SESSION_BUSY: 409,
      BROWSER_BUSY: 409,
      CONFIG_INVALID: 400,
      INVALID_INPUT: 400,
      GRANT_INVALID: 403,
    };
    return fail(res, statusMap[errObj.code ?? ''] ?? 500, errObj.code ?? 'INTERNAL', errObj.message ?? String(e));
  }
});
  return server;
}

const server = createApiServer(runtime, { token: token! });
const port = flags.port ?? config.api.port;
server.listen(port, config.api.host, () => {
  console.error(`[jev-browser-api] 已启动 http://${config.api.host}:${port}（loopback + token；数据目录 ${config.runtime.dataDir}）`);
});

async function shutdown(signal: string): Promise<void> {
  console.error(`[jev-browser-api] 收到 ${signal}，收尾中…`);
  server.close();
  await runtime.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
