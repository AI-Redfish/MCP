/**
 * @ai-redfish/server-a-core —— server-a 的核心逻辑层
 *
 * 只包含纯函数与工具元数据，不感知任何对外方式（stdio MCP / 命令行参数解析等）。
 * 上层的 mcp 适配器与 cli 适配器都只调用这里导出的能力，
 * 从而保证"同一个工具，多种提供方式"时行为完全一致。
 */

/** 服务的对外名称与版本（供各适配器统一引用，避免各写一份造成漂移） */
export const SERVER_NAME = 'server-a';
export const SERVER_VERSION = '0.1.0';

/** 工具参数元数据（CLI 据此自动生成用法与校验；MCP 侧据此定义 zod schema） */
export interface ToolParamMeta {
  /** 参数名 */
  name: string;
  /** 参数说明 */
  description: string;
  /** 是否必填 */
  required: boolean;
  /** 参数类型（当前示例只用到 string） */
  type: 'string';
}

/** 工具元数据：一个工具 = 名称 + 描述 + 参数列表 */
export interface ToolMeta {
  name: string;
  description: string;
  params: ToolParamMeta[];
}

// ---------------------------------------------------------------------------
// 纯业务函数（真正的"工具实现"）
// ---------------------------------------------------------------------------

/** 原样返回输入的消息 */
export function echo(message: string): string {
  return `[server-a] echo: ${message}`;
}

/** 返回服务器当前时间（ISO 8601 格式） */
export function now(): string {
  return `[server-a] server time: ${new Date().toISOString()}`;
}

// ---------------------------------------------------------------------------
// 工具目录与统一分发入口（供各适配器遍历注册 / 动态调用）
// ---------------------------------------------------------------------------

/** server-a 提供的全部工具（单一事实来源：MCP 注册与 CLI 帮助都从这里出发） */
export const TOOLS: ToolMeta[] = [
  {
    name: 'echo',
    description: '原样返回输入的消息（server-a 示例工具）',
    params: [{ name: 'message', description: '要回显的消息', required: true, type: 'string' }],
  },
  {
    name: 'now',
    description: '返回服务器当前时间（server-a 示例工具）',
    params: [],
  },
];

/** 工具入参：参数名 -> 参数值 */
export type ToolArgs = Record<string, unknown>;

/**
 * 对参数做最小校验并分发到对应纯函数。
 * 供 CLI 这类"工具名在运行时才确定"的动态调用方使用；
 * MCP 适配器的工具名在注册时确定，可直接调用具体纯函数。
 */
export function runTool(name: string, args: ToolArgs = {}): string {
  switch (name) {
    case 'echo': {
      const message = args.message;
      if (typeof message !== 'string') {
        throw new Error(`工具 "echo" 缺少 string 类型的必填参数 "message"`);
      }
      return echo(message);
    }
    case 'now':
      return now();
    default:
      throw new Error(`未知工具："${name}"（可用工具：${TOOLS.map((t) => t.name).join(', ')}）`);
  }
}
