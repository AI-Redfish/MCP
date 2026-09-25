"""配置（DESIGN §11）：来源优先级 CLI 显式参数 > 环境变量(JEV_DESKTOP_*) > 配置文件 > 默认值。

严格校验：未知字段报错；布尔只接受 true/false/1/0；配置文件内相对路径按文件所在目录解析。
Jev provider 预设：bocha（默认）/typesafe/vercel/zen/custom；key 一律经环境变量引用，
配置文件不落真实 key；doctor 输出脱敏。
"""

import json
import os
from pathlib import Path

from .errors import err

# ---------------------------------------------------------------------------
# Jev provider 预设（DESIGN §6.1）
# ---------------------------------------------------------------------------

JEV_PROVIDERS: dict[str, dict[str, str]] = {
    "bocha": {"baseUrl": "https://jev.bocha.cn", "model": "bocha-jev-v1"},
    "typesafe": {"baseUrl": "https://api.typesafe.ai", "model": "jev-latest"},
    "vercel": {"baseUrl": "https://ai-gateway.vercel.sh/typesafe", "model": "typesafe-ai/jev"},
    "zen": {"baseUrl": "https://opencode.ai/zen", "model": "jev-1.13"},
    "custom": {},
}

OBS_LEVELS = ("auto", "uia", "ocr", "vlm")


def default_base_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
        return Path(base) / "AI-Redfish" / "jev-desktop"
    xdg = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(xdg) / "jev-desktop"


def default_config() -> dict:
    base = default_base_dir()
    return {
        "schemaVersion": 1,
        "observation": {
            "level": "auto",
            "uia": {"maxDepth": 3, "maxElements": 800},
            "ocr": {"backend": "rapidocr"},
            "vlm": {"baseUrl": None, "model": None, "apiKeyEnv": None},
        },
        "planner": {
            "baseUrl": None,
            "model": None,
            "apiKeyEnv": "JEV_DESKTOP_PLANNER_API_KEY",
            "temperature": 0.2,
            "maxTokens": 2048,
            "timeoutMs": 60000,
        },
        "jev": {
            "provider": "bocha",
            "baseUrl": None,
            "model": None,
            "apiKeyEnv": "TYPESAFE_API_KEY",
            "doneAt": 0.85,
            "blockedAt": 0.7,
            "errorAt": 0.7,
            "confidenceAt": 0.6,
        },
        "runtime": {
            "runTimeoutMs": 120000,
            "actTimeoutMs": 30000,
            "snapshotTimeoutMs": 15000,
            "waitMaxMs": 30000,
            "maxSteps": 40,
            "maxPlannerRequests": 12,
            "maxJevRequests": 80,
            "maxInputTokens": 200000,
            "maxOutputTokens": 20000,
            "dataDir": str(base),
            "artifactsDir": str(base / "artifacts"),
            "logDir": str(base / "logs"),
        },
        "session": {
            "dir": str(base / "sessions"),
            "ttlMs": 3600000,
        },
        "log": {
            "actions": True,
        },
    }


# ---------------------------------------------------------------------------
# 严格合并
# ---------------------------------------------------------------------------

def _plain(v) -> bool:
    return isinstance(v, dict)


def _merge_into(target: dict, patch: dict, template: dict, where: str) -> None:
    """以 template 的键为准：未知键报错；标量与数组整体替换。"""
    for k, v in patch.items():
        if k not in template:
            raise err("CONFIG_INVALID", f"{where}: 未知字段 \"{k}\"")
        tv = template[k]
        if _plain(v) and _plain(tv):
            _merge_into(target[k], v, tv, f"{where}.{k}")
        elif _plain(v) or (isinstance(v, list) and _plain(tv)):
            raise err("CONFIG_INVALID", f"{where}.{k}: 类型错误")
        else:
            target[k] = v


def _parse_bool(where: str, v: str) -> bool:
    s = v.strip().lower()
    if s in ("true", "1"):
        return True
    if s in ("false", "0"):
        return False
    raise err("CONFIG_INVALID", f"{where}: 布尔只接受 true/false/1/0，得到 \"{v}\"")


def _apply_env(cfg: dict, env: dict) -> list[str]:
    used: list[str] = []

    def get(key: str):
        v = env.get(key)
        if v is not None and v != "":
            used.append(key)
        return v

    def set_num(obj: dict, key: str, env_key: str, *, integer: bool = False):
        v = get(env_key)
        if v is None:
            return
        try:
            n = int(v) if integer else float(v)
        except ValueError:
            raise err("CONFIG_INVALID", f"{env_key}: 需要数字，得到 \"{v}\"")
        obj[key] = n

    def set_str(obj: dict, key: str, env_key: str):
        v = get(env_key)
        if v is not None:
            obj[key] = v

    obs = cfg["observation"]
    lv = get("JEV_DESKTOP_OBS_LEVEL")
    if lv is not None:
        if lv not in OBS_LEVELS:
            raise err("CONFIG_INVALID", f"JEV_DESKTOP_OBS_LEVEL: 只允许 {'/'.join(OBS_LEVELS)}，得到 \"{lv}\"")
        obs["level"] = lv

    vlm = obs["vlm"]
    set_str(vlm, "baseUrl", "JEV_DESKTOP_VLM_BASE_URL")
    set_str(vlm, "model", "JEV_DESKTOP_VLM_MODEL")
    set_str(vlm, "apiKeyEnv", "JEV_DESKTOP_VLM_API_KEY_ENV")

    planner = cfg["planner"]
    set_str(planner, "baseUrl", "JEV_DESKTOP_PLANNER_BASE_URL")
    set_str(planner, "model", "JEV_DESKTOP_PLANNER_MODEL")
    set_str(planner, "apiKeyEnv", "JEV_DESKTOP_PLANNER_API_KEY_ENV")
    set_num(planner, "temperature", "JEV_DESKTOP_PLANNER_TEMPERATURE")
    set_num(planner, "maxTokens", "JEV_DESKTOP_PLANNER_MAX_TOKENS", integer=True)
    set_num(planner, "timeoutMs", "JEV_DESKTOP_PLANNER_TIMEOUT_MS", integer=True)

    jev = cfg["jev"]
    pv = get("JEV_DESKTOP_JEV_PROVIDER")
    if pv is not None:
        if pv not in JEV_PROVIDERS:
            raise err("CONFIG_INVALID", f"JEV_DESKTOP_JEV_PROVIDER: 只允许 {'/'.join(JEV_PROVIDERS)}，得到 \"{pv}\"")
        jev["provider"] = pv
    set_str(jev, "baseUrl", "JEV_DESKTOP_JEV_BASE_URL")
    set_str(jev, "model", "JEV_DESKTOP_JEV_MODEL")
    set_str(jev, "apiKeyEnv", "JEV_DESKTOP_JEV_API_KEY_ENV")

    rt = cfg["runtime"]
    set_num(rt, "runTimeoutMs", "JEV_DESKTOP_RUN_TIMEOUT_MS", integer=True)
    set_num(rt, "actTimeoutMs", "JEV_DESKTOP_ACT_TIMEOUT_MS", integer=True)
    set_num(rt, "snapshotTimeoutMs", "JEV_DESKTOP_SNAPSHOT_TIMEOUT_MS", integer=True)
    set_num(rt, "waitMaxMs", "JEV_DESKTOP_WAIT_MAX_MS", integer=True)
    set_num(rt, "maxSteps", "JEV_DESKTOP_MAX_STEPS", integer=True)
    set_num(rt, "maxPlannerRequests", "JEV_DESKTOP_MAX_PLANNER_REQUESTS", integer=True)
    set_num(rt, "maxJevRequests", "JEV_DESKTOP_MAX_JEV_REQUESTS", integer=True)
    set_num(rt, "maxInputTokens", "JEV_DESKTOP_MAX_INPUT_TOKENS", integer=True)
    set_num(rt, "maxOutputTokens", "JEV_DESKTOP_MAX_OUTPUT_TOKENS", integer=True)
    set_str(rt, "dataDir", "JEV_DESKTOP_DATA_DIR")
    set_str(rt, "artifactsDir", "JEV_DESKTOP_ARTIFACTS_DIR")
    set_str(rt, "logDir", "JEV_DESKTOP_LOG_DIR")

    sess = cfg["session"]
    set_str(sess, "dir", "JEV_DESKTOP_SESSION_DIR")
    set_num(sess, "ttlMs", "JEV_DESKTOP_SESSION_TTL_MS", integer=True)

    la = get("JEV_DESKTOP_LOG_ACTIONS")
    if la is not None:
        cfg["log"]["actions"] = _parse_bool("JEV_DESKTOP_LOG_ACTIONS", la)
    return used


def _resolve_provider(cfg: dict) -> None:
    """provider 预设填充 baseUrl/model（显式配置优先）。"""
    jev = cfg["jev"]
    provider = jev["provider"]
    preset = JEV_PROVIDERS[provider]
    if not jev.get("baseUrl"):
        if provider == "custom":
            raise err("CONFIG_INVALID", "jev.provider=custom 时必须显式配置 jev.baseUrl 与 jev.model")
        jev["baseUrl"] = preset["baseUrl"]
    if not jev.get("model"):
        if provider == "custom":
            raise err("CONFIG_INVALID", "jev.provider=custom 时必须显式配置 jev.model")
        jev["model"] = preset["model"]


def _validate_final(cfg: dict) -> None:
    if cfg["schemaVersion"] != 1:
        raise err("CONFIG_INVALID", f"schemaVersion 只支持 1，得到 {cfg['schemaVersion']!r}")
    for key in ("runTimeoutMs", "actTimeoutMs", "snapshotTimeoutMs", "waitMaxMs"):
        v = cfg["runtime"][key]
        if not isinstance(v, int) or v <= 0:
            raise err("CONFIG_INVALID", f"runtime.{key} 必须是正整数毫秒，得到 {v!r}")
    for key in ("maxSteps", "maxPlannerRequests", "maxJevRequests"):
        v = cfg["runtime"][key]
        if not isinstance(v, int) or v <= 0:
            raise err("CONFIG_INVALID", f"runtime.{key} 必须是正整数，得到 {v!r}")
    _resolve_provider(cfg)
    obs = cfg["observation"]
    if obs["level"] not in OBS_LEVELS:
        raise err("CONFIG_INVALID", f"observation.level 只允许 {'/'.join(OBS_LEVELS)}")
    jev = cfg["jev"]
    for name in ("doneAt", "blockedAt", "errorAt", "confidenceAt"):
        v = jev[name]
        if not isinstance(v, (int, float)) or not (0 < v < 1):
            raise err("CONFIG_INVALID", f"jev.{name} 必须在 (0,1)，得到 {v!r}")


def user_config_file() -> Path:
    return default_base_dir() / "config.json"


def load_config(file: str | None = None, env: dict | None = None, overrides: dict | None = None) -> dict:
    """按优先级合并配置并严格校验。file 为 --config 显式路径，存在则必须可用。"""
    env = dict(os.environ if env is None else env)
    cfg = default_config()

    # 1) 文件：显式 --config > JEV_DESKTOP_CONFIG > 用户配置目录
    path = file or env.get("JEV_DESKTOP_CONFIG") or ""
    if not path and user_config_file().exists():
        path = str(user_config_file())
    if path:
        p = Path(path)
        if not p.exists():
            if file:  # 显式指定但不存在 → 报错；用户目录默认文件不存在则忽略
                raise err("CONFIG_INVALID", f"配置文件不存在: {path}")
        else:
            try:
                parsed = json.loads(p.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError) as e:
                raise err("CONFIG_INVALID", f"配置文件解析失败 {path}: {e}")
            if not isinstance(parsed, dict):
                raise err("CONFIG_INVALID", f"配置文件顶层必须是对象: {path}")
            _merge_into(cfg, parsed, default_config(), "file")
            # 相对路径按配置文件所在目录解析（DESIGN §11）
            base = p.parent
            for sec, key in (("runtime", "dataDir"), ("runtime", "artifactsDir"), ("runtime", "logDir"), ("session", "dir")):
                v = cfg[sec][key]
                if isinstance(v, str) and v and not Path(v).is_absolute():
                    cfg[sec][key] = str((base / v).resolve())

    # 2) 环境变量
    _apply_env(cfg, env)

    # 3) CLI 显式覆盖（已是解析后的局部 dict，仍走严格合并）
    if overrides:
        _merge_into(cfg, overrides, default_config(), "overrides")

    _validate_final(cfg)
    return cfg


def redact_config(cfg: dict) -> dict:
    """doctor 用脱敏输出：只输出 key 的环境变量名，绝不输出值。"""
    clone = json.loads(json.dumps(cfg))
    clone["jev"]["apiKeyEnv"] = str(clone["jev"]["apiKeyEnv"])
    clone["planner"]["apiKeyEnv"] = str(clone["planner"]["apiKeyEnv"])
    vlm = clone["observation"]["vlm"]
    if vlm.get("apiKeyEnv"):
        vlm["apiKeyEnv"] = str(vlm["apiKeyEnv"])
    return clone


def credential_present(cfg: dict, kind: str, env: dict | None = None) -> bool:
    env = os.environ if env is None else env
    if kind == "jev":
        name = cfg["jev"]["apiKeyEnv"]
    elif kind == "planner":
        name = cfg["planner"]["apiKeyEnv"]
    elif kind == "vlm":
        name = cfg["observation"]["vlm"].get("apiKeyEnv") or cfg["planner"]["apiKeyEnv"]
    else:
        return False
    v = env.get(name)
    return isinstance(v, str) and len(v) > 0
