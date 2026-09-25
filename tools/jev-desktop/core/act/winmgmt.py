"""窗口管理（DESIGN §5）：launch/close/focus/minimize/maximize/restore/move/resize/list。

uiautomation 自带 helper 思路 + 纯 ctypes 实现；launch 支持可执行文件、PATH 命令与
常用应用别名，并等待窗口出现（受 waitMaxMs 约束）。
"""

import os
import shlex
import shutil
import subprocess
import time

from ..errors import err
from .. import winapi

APP_ALIASES: dict[str, str] = {
    "记事本": "notepad", "notepad": "notepad",
    "计算器": "calc", "calc": "calc", "calculator": "calc",
    "画图": "mspaint", "mspaint": "mspaint", "paint": "mspaint",
    "资源管理器": "explorer", "explorer": "explorer",
    "命令提示符": "cmd", "cmd": "cmd", "终端": "wt", "terminal": "wt",
    "写字板": "write", "write": "write", "wordpad": "write",
    "字符映射表": "charmap", "charmap": "charmap",
    "运行": "run", "run": "run",
    "任务管理器": "taskmgr", "taskmgr": "taskmgr",
    "控制面板": "control", "control": "control",
}


def resolve_launch_cmd(name: str) -> list[str]:
    """把 app 名称解析成可执行命令。"""
    name = (name or "").strip()
    if not name:
        raise err("INVALID_PARAMS", "launch 需要应用名或可执行路径")
    # 已经是路径/带参数的命令
    if os.path.isabs(name) or "/" in name or "\\" in name:
        parts = shlex.split(name, posix=False) if os.name == "nt" else shlex.split(name)
        return [p.strip('"') for p in parts]
    alias = APP_ALIASES.get(name.lower()) or APP_ALIASES.get(name)
    target = alias or name
    exe = target if target.lower().endswith(".exe") else target + ".exe"
    found = shutil.which(target) or shutil.which(exe)
    if found:
        return [found]
    # 系统目录兜底（System32 下的小工具不必在 PATH）
    for d in (os.environ.get("SystemRoot", r"C:\Windows") + r"\System32",):
        p = os.path.join(d, exe)
        if os.path.exists(p):
            return [p]
    # UWP/商店应用：经 explorer shell: 打开（如 calc 别名已覆盖，此处兜底）
    raise err("APP_NOT_FOUND",
              f"找不到应用 \"{name}\"：请给出可执行文件路径，或使用 PATH 内命令名"
              f"（内置别名：{'、'.join(sorted({k for k in APP_ALIASES if not k.isascii()}))} 等）")


def launch(cmd: list[str], *, wait_ms: int, title_hint: str | None = None) -> dict:
    """启动进程并等待其顶层窗口出现。返回 {pid, hwnd?, title?}。"""
    before = {w.hwnd for w in winapi.list_top_windows()}
    try:
        proc = subprocess.Popen(cmd, cwd=os.getcwd(), shell=False)
    except FileNotFoundError as e:
        raise err("APP_NOT_FOUND", f"启动失败: {e}")
    except OSError as e:
        raise err("APP_NOT_FOUND", f"启动失败: {e}")
    deadline = time.monotonic() + max(1.0, wait_ms / 1000)
    while time.monotonic() < deadline:
        wins = winapi.list_top_windows()
        fresh = [w for w in wins if w.hwnd not in before and w.pid == proc.pid]
        if not fresh and title_hint:
            fresh = [w for w in wins if w.hwnd not in before and title_hint.lower() in w.title.lower()]
        if fresh:
            w = fresh[0]
            return {"pid": w.pid, "hwnd": w.hwnd, "title": w.title, "launchedPid": proc.pid}
        time.sleep(0.15)
    return {"pid": proc.pid, "hwnd": None, "title": None, "launchedPid": proc.pid,
            "note": "进程已启动但未检测到新窗口（可能是单实例应用或启动较慢）"}


def close_window(hwnd: int) -> None:
    if not winapi.is_window(hwnd):
        raise err("WINDOW_LOST", f"窗口 {hwnd} 已不存在")
    if not winapi.send_message_safe(hwnd, winapi.WM_CLOSE, 0, 0):
        raise err("WINDOW_LOST", f"窗口 {hwnd} 关闭消息发送失败（窗口可能挂起）")


def focus_window(hwnd: int) -> None:
    if not winapi.is_window(hwnd):
        raise err("WINDOW_LOST", f"窗口 {hwnd} 已不存在")
    if not winapi.focus_window(hwnd):
        raise err("INPUT_DENIED",
                  f"无法把窗口 {hwnd} 置前台（前台锁/UIPI 限制）；坐标类动作需要目标窗口在前台")


def move_window(hwnd: int, x: int, y: int) -> None:
    winapi.user32.SetWindowPos(hwnd, 0, int(x), int(y), 0, 0, 0x0001 | 0x0004)  # NOSIZE|NOZORDER


def resize_window(hwnd: int, w: int, h: int) -> None:
    if w <= 0 or h <= 0:
        raise err("INVALID_PARAMS", f"resize 尺寸必须为正: {w}x{h}")
    winapi.user32.SetWindowPos(hwnd, 0, 0, 0, int(w), int(h), 0x0002 | 0x0004)  # NOMOVE|NOZORDER
