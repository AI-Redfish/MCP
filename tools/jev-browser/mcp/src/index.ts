#!/usr/bin/env node
/**
 * @ai-redfish/jev-browser-mcp —— MCP 适配器（stdio）
 *
 * 只做协议注册：zod schema + handler 转发 core；工具名/描述复用 core TOOLS。
 * stdout 是 MCP 协议通道；本文件所有日志写 stderr。
 *
 * 长驻模式（可选）：环境变量 JEV_BROWSER_API_URL + JEV_BROWSER_API_TOKEN 时，
 * 所有调用转发到本地长驻 API（多客户端共享一次 CDP 连接，DESIGN §9.2）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ApiClient,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  Runtime,
  loadConfig,
  runDoctor,
  type TaskEnvelope,
} from '@ai-redfish/jev-browser-core';

const PRINCIPAL = process.env.JEV_BROWSER_MCP_PRINCIPAL ?? 'mcp';
const apiMode = process.env.JEV_BROWSER_API_URL && process.env.JEV_BROWSER_API_TOKEN;

const api = apiMode
  ? new ApiClient({ baseUrl: process.env.JEV_BROWSER_API_URL!, token: process.env.JEV_BROWSER_API_TOKEN! })
  : null;

let runtime: Runtime | null = null;
async function rt(): Promise<Runtime> {
  if (!runtime) {
    const { config } = loadConfig();
    runtime = new Runtime(config);
    const recovery = runtime.recoverOnStartup();
    console.error(`[jev-browser-mcp] 崩溃恢复: ${recovery.recovered} 个遗留任务转为暂停${recovery.isolated ? '（存在未知在途动作，已隔离）' : ''}`);
  }
  return runtime;
}

const originSchema = z.array(z.string()).describe('http/https origin 列表，如 ["https://example.com"]');

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function textErr(e: unknown) {
  const errObj = e as { code?: string; message?: string };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: errObj.code ?? 'INTERNAL', message: errObj.message ?? String(e) } }, null, 2) }],
    isError: true,
  };
}

server.tool('browser_doctor', TOOLS[0].description, { connect: z.boolean().optional().describe('尝试接管（需 Chrome 授权）') }, async ({ connect }) => {
  try {
    if (api) return text(await api.diagnostics());
    const result = await runDoctor({ attemptConnect: connect ?? false });
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_connect', TOOLS[1].description, {
  url: z.string().optional(),
  pageId: z.string().optional(),
  allowedOrigins: originSchema,
  modelOrigins: z.array(z.string()).optional().describe('允许云模型外发的 origin；必须 ⊆ allowedOrigins'),
}, async ({ url, pageId, allowedOrigins, modelOrigins }) => {
  try {
    const input = { target: url ? { kind: 'new', url } : { kind: 'existing', pageId }, allowedOrigins, modelOrigins: modelOrigins ?? [] };
    const result = api ? await api.createSession(input) : await (await rt()).createSession(PRINCIPAL, input as never);
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_pages', TOOLS[2].description, { sessionId: z.string() }, async ({ sessionId }) => {
  try {
    const result = api ? await api.pages(sessionId) : await (await rt()).listPages(PRINCIPAL, sessionId);
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_select_page', TOOLS[3].description, { sessionId: z.string(), pageId: z.string() }, async ({ sessionId, pageId }) => {
  try {
    const result = api ? await api.selectPage(sessionId, pageId) : await (await rt()).selectPage(PRINCIPAL, sessionId, pageId);
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_snapshot', TOOLS[6].description, { sessionId: z.string(), forModel: z.boolean().optional() }, async ({ sessionId, forModel }) => {
  try {
    if (api) {
      // API 模式下快照经 act/execute 之外的专用路径暂未开放：提示使用 embedded 或 API 扩展
      return text({ hint: 'API 长驻模式暂不提供 snapshot 透传；请使用 embedded 模式或通过 execute 提取步骤' });
    }
    const obs = await (await rt()).snapshot(PRINCIPAL, sessionId, { forModel });
    return text(obs);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_execute', TOOLS[4].description, {
  sessionId: z.string(),
  steps: z.array(z.record(z.unknown())).describe('FlowStep[]；导航/写操作需 expect 后置条件'),
  values: z.record(z.unknown()).optional().describe('值字典；敏感值用 {"secretRef":"NAME"}'),
}, async ({ sessionId, steps, values }) => {
  try {
    const input = { sessionId, steps, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> };
    const queued = api
      ? (await api.execute(input)) as unknown as TaskEnvelope
      : await (await rt()).execute(PRINCIPAL, sessionId, input as never);
    const env = api ? await pollUntilPaused(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_run', TOOLS[5].description, {
  sessionId: z.string(),
  goal: z.string(),
  successCriteria: z.string().describe('用户可观察的验收条件；防止规划器自证成功'),
  values: z.record(z.unknown()).optional(),
}, async ({ sessionId, goal, successCriteria, values }) => {
  try {
    const input = { sessionId, goal, successCriteria, values: values ?? {} };
    const queued = api
      ? (await api.run(input)) as unknown as TaskEnvelope
      : await (await rt()).run(PRINCIPAL, sessionId, input as never);
    const env = api ? await pollUntilPaused(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_act', TOOLS[7].description, {
  sessionId: z.string(),
  step: z.record(z.unknown()).describe('单个 ActionStep'),
  values: z.record(z.unknown()).optional(),
}, async ({ sessionId, step, values }) => {
  try {
    const input = { step, values: values ?? {} };
    const queued = api
      ? (await api.act(sessionId, input)) as unknown as TaskEnvelope
      : await (await rt()).act(PRINCIPAL, sessionId, { sessionId, step: step as never, values: (values ?? {}) as Record<string, import('@ai-redfish/jev-browser-core').ValueInput> });
    const env = api ? await pollUntilPaused(api, queued.taskId) : await (await rt()).waitEnvelope(queued.taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_get', TOOLS[8].description, { taskId: z.string() }, async ({ taskId }) => {
  try {
    const env = api ? (await api.getTask(taskId)).envelope : (await rt()).getTask(PRINCIPAL, taskId);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_cancel', TOOLS[9].description, {
  taskId: z.string(),
  requestId: z.string().describe('幂等请求 ID（重复调用返回原结果）'),
  expectedRevision: z.number().optional(),
}, async ({ taskId, requestId, expectedRevision }) => {
  try {
    const env = api ? (await api.cancelTask(taskId, { requestId, expectedRevision })).envelope : await (await rt()).cancelTask(PRINCIPAL, taskId, { requestId, expectedRevision });
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_resume', TOOLS[10].description, {
  taskId: z.string(),
  requestId: z.string(),
  expectedRevision: z.number().optional(),
  rerunConfirmed: z.boolean().optional().describe('未知结果/歧义暂停后，人工确认允许重跑当前步骤'),
}, async ({ taskId, requestId, expectedRevision, rerunConfirmed }) => {
  try {
    const opts = { requestId, expectedRevision, rerunConfirmed };
    const env = api ? (await api.resumeTask(taskId, opts)).envelope : await (await rt()).resumeTask(PRINCIPAL, taskId, opts);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_task_approve', TOOLS[11].description, {
  taskId: z.string(),
  grant: z.string().describe('HMAC grant token（独立签发，不注入执行 Agent）'),
}, async ({ taskId, grant }) => {
  try {
    const env = api ? (await api.approveTask(taskId, { grant })).envelope : (await rt()).approveTask(PRINCIPAL, taskId, grant);
    return text(env);
  } catch (e) {
    return textErr(e);
  }
});

server.tool('browser_disconnect', TOOLS[13].description, {
  sessionId: z.string(),
  detachTask: z.boolean().optional().describe('有暂停任务时，显式 detach 才允许断开'),
}, async ({ sessionId, detachTask }) => {
  try {
    const result = api ? await api.disconnect(sessionId, detachTask) : await (await rt()).disconnect(PRINCIPAL, sessionId, { detachTask });
    return text(result);
  } catch (e) {
    return textErr(e);
  }
});

async function pollUntilPaused(client: ApiClient, taskId: string): Promise<TaskEnvelope> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const { envelope } = await client.getTask(taskId);
    if (envelope.status === 'paused' || ['done', 'failed', 'expired', 'cancelled'].includes(envelope.status)) return envelope;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等待任务超时');
}

server.connect(new StdioServerTransport()).then(() => {
  console.error(`[${SERVER_NAME}] MCP 服务已启动（stdio 传输；${apiMode ? 'API 转发模式' : '嵌入模式'}）`);
});
