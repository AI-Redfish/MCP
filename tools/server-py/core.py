"""
server-py 核心逻辑：纯函数 + 工具元数据（与 server-a 的 core 同构）。

不感知任何对外方式：mcp_server.py 与 cli.py 都只调用这里导出的能力，
保证"同一个工具，多种提供方式"时行为一致。
"""

SERVER_NAME = "server-py"
SERVER_VERSION = "0.1.0"

# 工具元数据：单一事实来源（MCP 注册与 CLI 用法都从这里出发）
TOOLS = [
    {
        "name": "echo",
        "description": "原样返回输入的消息（server-py 示例工具，Python 实现）",
        "params": [
            {"name": "message", "description": "要回显的消息", "required": True, "type": "string"},
        ],
    },
    {
        "name": "now",
        "description": "返回服务器当前时间（server-py 示例工具，Python 实现）",
        "params": [],
    },
]


# ---------------------------------------------------------------------------
# 纯业务函数（真正的"工具实现"）
# ---------------------------------------------------------------------------

def echo(message: str) -> str:
    """原样返回输入的消息"""
    return f"[server-py] echo: {message}"


def now() -> str:
    """返回服务器当前时间（ISO 8601，UTC）"""
    from datetime import datetime, timezone

    return f"[server-py] server time: {datetime.now(timezone.utc).isoformat()}"


# ---------------------------------------------------------------------------
# 统一分发入口（供动态调用方使用）
# ---------------------------------------------------------------------------

def run_tool(name: str, args: dict | None = None) -> str:
    """对参数做最小校验并分发到对应纯函数"""
    args = args or {}
    if name == "echo":
        message = args.get("message")
        if not isinstance(message, str):
            raise ValueError('工具 "echo" 缺少 string 类型的必填参数 "message"')
        return echo(message)
    if name == "now":
        return now()
    raise ValueError(f'未知工具："{name}"（可用工具：{", ".join(t["name"] for t in TOOLS)}）')
