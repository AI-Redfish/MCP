#!/usr/bin/env python3
"""
server-py 的 CLI 适配器：argparse 解析参数 -> core.run_tool。

用法：
  python cli.py list                    列出所有可用工具
  python cli.py echo <message>          位置参数方式
  python cli.py echo --message <msg>    命名参数方式
  python cli.py now
"""

import argparse
import sys

from core import SERVER_NAME, SERVER_VERSION, TOOLS, run_tool

# Windows 控制台默认 GBK，统一为 UTF-8，避免中文乱码
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"{SERVER_NAME}-cli",
        description=f"{SERVER_NAME} CLI（v{SERVER_VERSION}）",
    )
    parser.add_argument("--version", action="version", version=f"{SERVER_NAME}-cli v{SERVER_VERSION}")
    sub = parser.add_subparsers(dest="tool", required=False)

    # 从 core 的 TOOLS 元数据自动生成子命令（与 TypeScript 版 cli 的做法同构）；
    # 每个参数同时支持位置式与 --name 命名式，命名式优先
    for tool in TOOLS:
        sp = sub.add_parser(tool["name"], help=tool["description"])
        for param in tool["params"]:
            sp.add_argument("--" + param["name"], dest=param["name"] + "_named",
                            help=param["description"] + "（命名式）")
            sp.add_argument(param["name"], nargs="?", default=None,
                            help=param["description"] + "（位置式）")
    sub.add_parser("list", help="列出所有可用工具")
    return parser


def print_tools() -> None:
    print(f"[{SERVER_NAME}] 可用工具：")
    for tool in TOOLS:
        print(f"  - {tool['name']}    {tool['description']}")


def main() -> None:
    ns = build_parser().parse_args()
    if not ns.tool or ns.tool == "list":
        print_tools()
        return

    tool = next((t for t in TOOLS if t["name"] == ns.tool), None)
    args: dict = {}
    missing = []
    for param in tool["params"]:
        value = getattr(ns, param["name"] + "_named", None) or getattr(ns, param["name"], None)
        if value is not None:
            args[param["name"]] = value
        elif param["required"]:
            missing.append(f'{param["name"]}（{param["description"]}）')

    if missing:
        print(f"[{SERVER_NAME}-cli] 工具 \"{tool['name']}\" 缺少必填参数：{'、'.join(missing)}", file=sys.stderr)
        sys.exit(1)

    try:
        print(run_tool(tool["name"], args))
    except ValueError as err:
        print(f"[{SERVER_NAME}-cli] {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
