"""
server-py 的 MCP 适配器（纯标准库实现）。

MCP stdio 传输 = 每行一条 JSON-RPC 2.0 消息。
真实项目建议改用官方 Python SDK（pip install "mcp"）；本文件手写最小协议，
用于演示：启动器可以拉起任意语言实现的 MCP Server。

注意：stdout 是协议通道，日志必须写 stderr。
"""

import json
import sys

from core import SERVER_NAME, SERVER_VERSION, TOOLS, run_tool

# Windows 控制台/管道默认可能是 GBK，MCP 协议要求 UTF-8，强制统一
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

PROTOCOL_VERSION = "2024-11-05"


def tool_schema(tool: dict) -> dict:
    """把 core 的 TOOLS 元数据转成 MCP 的 inputSchema（JSON Schema）"""
    return {
        "type": "object",
        "properties": {
            p["name"]: {"type": p["type"], "description": p["description"]}
            for p in tool["params"]
        },
        "required": [p["name"] for p in tool["params"] if p["required"]],
    }


def handle(method: str, params: dict) -> dict:
    """处理请求，返回 result；未知方法抛 ValueError"""
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }
    if method == "tools/list":
        return {
            "tools": [
                {
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": tool_schema(t),
                }
                for t in TOOLS
            ]
        }
    if method == "tools/call":
        try:
            text = run_tool(params["name"], params.get("arguments", {}))
            return {"content": [{"type": "text", "text": text}]}
        except Exception as err:  # 工具执行失败以 isError 返回，不打断会话
            return {"content": [{"type": "text", "text": str(err)}], "isError": True}
    raise ValueError(f"未知方法：{method}")


def main() -> None:
    print(f"[{SERVER_NAME}] MCP 服务已启动（stdio 传输，Python 实现）", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as err:
            print(f"[{SERVER_NAME}] 忽略非法 JSON 行：{err}", file=sys.stderr)
            continue

        if "id" not in msg:
            continue  # notification（如 notifications/initialized）：无需应答

        resp: dict = {"jsonrpc": "2.0", "id": msg["id"]}
        try:
            resp["result"] = handle(msg.get("method", ""), msg.get("params") or {})
        except ValueError as err:
            resp["error"] = {"code": -32601, "message": str(err)}

        print(json.dumps(resp, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
