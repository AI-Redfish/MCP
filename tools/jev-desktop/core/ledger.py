"""动作账本（DESIGN ADR-05 / §15）：JSONL 仅观测，不拦截任何动作。

不含值全文（type/set_value 文本截断存储），绝不含 key。
"""

import json
import time
from pathlib import Path


class Ledger:
    def __init__(self, log_dir: str, enabled: bool):
        self.enabled = enabled
        self.path = Path(log_dir) / "actions.jsonl" if enabled else None

    def record(self, *, tool: str, action: str, target: str | None = None, value: str | None = None,
               outcome: str = "ok", detail: dict | None = None, duration_ms: int = 0,
               session: str = "default") -> None:
        if not self.enabled or self.path is None:
            return
        entry = {
            "ts": int(time.time() * 1000),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
            "session": session,
            "tool": tool,
            "action": action,
            "target": (target or "")[:200],
            "value": _truncate_value(value),
            "outcome": outcome,
            "durationMs": duration_ms,
        }
        if detail:
            entry["detail"] = _safe(detail)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass


def _truncate_value(value: str | None) -> str | None:
    if value is None:
        return None
    s = str(value).replace("\n", "\\n").replace("\r", "\\r")
    if len(s) > 60:
        return s[:60] + f"…(len={len(s)})"
    return s


def _safe(detail: dict, depth: int = 0) -> dict:
    if depth > 3:
        return {}
    out: dict = {}
    for k, v in detail.items():
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = _truncate_value(v) if isinstance(v, str) else v
        elif isinstance(v, dict):
            out[k] = _safe(v, depth + 1)
        elif isinstance(v, list):
            out[k] = [_truncate_value(x) if isinstance(x, str) else x for x in v[:10]]
    return out
