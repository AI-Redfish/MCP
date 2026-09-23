#!/usr/bin/env node
/**
 * server-a —— 示例 MCP 子服务
 *
 * 演示一个标准 stdio MCP Server 的最小实现，包含两个工具：
 *   - echo : 原样返回输入的消息
 *   - now  : 返回服务器当前时间
 *
 * 注意：stdio 传输下 stdout 是协议通道，服务自身的日志必须写到 stderr（console.error）。
 */
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({
  name: 'server-a',
  version: '0.1.0',
});

server.tool('echo', '原样返回输入的消息（server-a 示例工具）', { message: z.string() }, async ({ message }) => ({
  content: [{ type: 'text', text: `[server-a] echo: ${message}` }],
}));

server.tool('now', '返回服务器当前时间（server-a 示例工具）', {}, async () => ({
  content: [{ type: 'text', text: `[server-a] server time: ${new Date().toISOString()}` }],
}));

server.connect(new StdioServerTransport()).then(() => {
  console.error('[server-a] MCP 服务已启动（stdio 传输）');
});
