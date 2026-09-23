#!/usr/bin/env node
/**
 * @ai-redfish/server-a-mcp —— server-a 的 MCP 适配器
 *
 * 只做协议适配：把 core 中的工具以标准 stdio MCP Server 的形式暴露出去。
 * 业务实现全部在 @ai-redfish/server-a-core，与 cli 适配器共享。
 *
 * 注意：stdio 传输下 stdout 是协议通道，服务自身的日志必须写到 stderr（console.error）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION, TOOLS, echo, now } from '@ai-redfish/server-a-core';

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// 工具名称/描述复用 core 的 TOOLS 元数据，保证与 CLI 侧文案一致、不漂移
const echoMeta = TOOLS.find((t) => t.name === 'echo')!;
const nowMeta = TOOLS.find((t) => t.name === 'now')!;

server.tool(echoMeta.name, echoMeta.description, { message: z.string() }, async ({ message }) => ({
  content: [{ type: 'text', text: echo(message) }],
}));

server.tool(nowMeta.name, nowMeta.description, {}, async () => ({
  content: [{ type: 'text', text: now() }],
}));

server.connect(new StdioServerTransport()).then(() => {
  console.error(`[${SERVER_NAME}] MCP 服务已启动（stdio 传输）`);
});
