#!/usr/bin/env node
/**
 * @ai-redfish/server-a-cli —— server-a 的 CLI 适配器
 *
 * 不含任何业务逻辑：解析命令行参数后调用 core 的 runTool，
 * 与 mcp 适配器共享同一份核心实现。
 *
 * 用法：
 *   server-a-cli <tool> [参数...]
 *   server-a-cli echo <message>          位置参数方式
 *   server-a-cli echo --message <msg>    命名参数方式
 *   server-a-cli list                    列出所有可用工具
 *   server-a-cli help                    显示帮助
 */
import {
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  runTool,
  type ToolArgs,
  type ToolMeta,
} from '@ai-redfish/server-a-core';

/** 打印帮助（工具清单自动从 core 的 TOOLS 元数据生成，保证与 MCP 侧描述一致） */
function printUsage(): void {
  const lines: string[] = [
    `${SERVER_NAME} CLI（v${SERVER_VERSION}）`,
    '',
    '用法：',
    `  ${SERVER_NAME}-cli <tool> [参数...]`,
    `  ${SERVER_NAME}-cli echo <message>        位置参数方式`,
    `  ${SERVER_NAME}-cli echo --message hi     命名参数方式`,
    '',
    '命令：',
    '  list        列出所有可用工具',
    '  help        显示本帮助',
    '',
    '可用工具：',
  ];
  for (const tool of TOOLS) {
    const params = tool.params.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(' ');
    lines.push(`  ${tool.name} ${params}    ${tool.description}`);
  }
  console.log(lines.join('\n'));
}

/** 打印工具清单 */
function printList(): void {
  console.log(`[${SERVER_NAME}] 可用工具：`);
  for (const tool of TOOLS) {
    console.log(`  - ${tool.name}    ${tool.description}`);
  }
}

interface ParsedArgs {
  named: Record<string, string | boolean>;
  positional: string[];
}

/** 极简 argv 解析：支持 --name value、--name=value、位置参数三种形式 */
function parseCliArgs(argv: string[]): ParsedArgs {
  const named: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        named[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        named[body] = next;
        i++;
      } else {
        named[body] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { named, positional };
}

/** 按工具元数据组装入参：优先命名参数，缺失时按顺序消费位置参数 */
function buildToolArgs(tool: ToolMeta, parsed: ParsedArgs): ToolArgs {
  const args: ToolArgs = {};
  let posIdx = 0;
  for (const param of tool.params) {
    const namedVal = parsed.named[param.name];
    if (typeof namedVal === 'string') {
      args[param.name] = namedVal;
      continue;
    }
    const posVal = parsed.positional[posIdx];
    if (posVal !== undefined) {
      args[param.name] = posVal;
      posIdx++;
      continue;
    }
    if (param.required) {
      throw new Error(`工具 "${tool.name}" 缺少必填参数 "${param.name}"（${param.description}）`);
    }
  }
  return args;
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    printUsage();
    return;
  }
  if (['-v', '--version'].includes(cmd)) {
    console.log(`${SERVER_NAME}-cli v${SERVER_VERSION}`);
    return;
  }
  if (['list', '-l', '--list'].includes(cmd)) {
    printList();
    return;
  }

  const tool = TOOLS.find((t) => t.name === cmd);
  if (!tool) {
    console.error(`未知工具："${cmd}"。运行 "${SERVER_NAME}-cli list" 查看可用工具。`);
    process.exit(1);
  }

  try {
    const args = buildToolArgs(tool, parseCliArgs(rest));
    console.log(runTool(tool.name, args));
  } catch (err) {
    console.error(`[${SERVER_NAME}-cli] ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
