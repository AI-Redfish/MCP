"""TOOLS 元数据：单一事实来源（DESIGN §10）。

MCP 注册（inputSchema）与 CLI 子命令生成均从这里出发。
- 标量参数（string/integer/number/boolean）：CLI 生成 --name 旗标；
- object/array 参数：CLI 接受内联 JSON 字符串或 @file/路径 引用 JSON 文件；
- schema 字段是完整 JSON Schema 片段，供 MCP inputSchema 直接引用。

约定：全局参数（--config/--json/--dry-run/--session/--timeout）由适配器自行处理，
不属于单个工具的 params。
"""

SERVER_NAME = "jev-desktop"
SERVER_VERSION = "0.1.0"

_WINDOW_ARGS = [
    {"name": "app", "type": "string", "required": False,
     "description": "目标应用：进程名（notepad）/ pid / 标题包含的子串；缺省时优先会话最近窗口，否则前台窗口"},
    {"name": "title", "type": "string", "required": False, "description": "窗口标题子串（大小写不敏感），与 app 二选一更精确"},
    {"name": "window_id", "type": "integer", "required": False, "description": "顶层窗口句柄（hwnd，windows 工具返回的 id）"},
]

_LEVEL_DESC = "观察档位：auto（默认，UIA 探测→OCR 降级）/ uia / ocr / vlm"

TARGET_SPEC_DOC = (
    'TargetSpec：{"kind":"ref","ref":"@<快照id>:eN"} | {"kind":"uia","controlType":"Button","name":"保存",'
    '"automationId":"btn-save","index":0} | {"kind":"coords","x":500,"y":300} | '
    '{"kind":"text","target":"搜索框"}（语义目标，经 Jev 选择）| {"kind":"none"}'
)

TOOLS = [
    {
        "name": "desktop_doctor",
        "description": "环境诊断：UIA/截图/OCR/剪贴板/DPI/提权/会话目录；--with-network 才连通 Jev 与规划器（输出脱敏，绝不打印 key）",
        "params": [
            {"name": "with_network", "type": "boolean", "required": False,
             "description": "是否联网探测 Jev/规划器连通性（会产生一次极小模型请求）", "default": False},
        ],
    },
    {
        "name": "desktop_windows",
        "description": "列出当前可见顶层窗口（标题/pid/进程/矩形/前台标记），用于选择 snapshot/act/run 的目标",
        "params": [],
    },
    {
        "name": "desktop_snapshot",
        "description": "观察目标窗口，返回紧凑文本快照 + 可引用的 ref 列表（@<快照id>:eN=UIA 元素，:bN=文字块）。"
                       "动作前先 snapshot；ref 在会话内复用（默认会话 default）",
        "params": _WINDOW_ARGS + [
            {"name": "level", "type": "string", "required": False, "description": _LEVEL_DESC},
            {"name": "root", "type": "string", "required": False,
             "description": "从某个 UIA ref 局部下钻（渐进骨架遍历，治理密集应用 token 膨胀）"},
            {"name": "depth", "type": "integer", "required": False, "description": "UIA 遍历深度（默认取配置 observation.uia.maxDepth=3）"},
            {"name": "max_elements", "type": "integer", "required": False, "description": "元素数上限（默认配置 observation.uia.maxElements=800）"},
            {"name": "save_artifact", "type": "boolean", "required": False,
             "description": "是否把截图存为 artifact（ocr/vlm 档自动保存）", "default": False},
            {"name": "session", "type": "string", "required": False, "description": "会话 id（默认 default；ref 跨调用复用）"},
        ],
    },
    {
        "name": "desktop_act",
        "description": "对目标执行单个动作。优先 UIA 语义动作（invoke/set_value/toggle/select/expand/scroll，不抢焦点）；"
                       "坐标类动作用 SendInput 绝对坐标（会把窗口置前台，期间请勿占用鼠标键盘）。\n"
       f"target 为 TargetSpec：{TARGET_SPEC_DOC}",
        "params": [
            {"name": "action", "type": "string", "required": True,
             "description": "invoke|click|double_click|right_click|hover|drag|type|set_value|press|scroll|select|toggle|check|uncheck|"
                            "expand|collapse|focus|launch|close|minimize|maximize|restore|move|resize|clipboard_get|clipboard_set"},
            {"name": "target", "type": "object", "required": False, "description": "TargetSpec 对象；省略时为全局动作（press/launch/窗口管理等）"},
            {"name": "value", "type": "string", "required": False,
             "description": "动作参数：type=文本；press=键组合（ctrl+s）；scroll=down|up|left|right[:次数]；move=x,y；resize=w,h；"
                            "select=选项文本；clipboard_set=内容；drag=x2,y2 终点坐标"},
        ] + _WINDOW_ARGS + [
            {"name": "session", "type": "string", "required": False, "description": "会话 id（默认 default）"},
            {"name": "dry_run", "type": "boolean", "required": False, "description": "只解析与校验目标，不执行动作", "default": False},
        ],
    },
    {
        "name": "desktop_execute",
        "description": "执行明确步骤数组（无内部规划；确定性动作零模型调用）。步骤 kind：action|wait|screenshot|extract|assert|goal。"
                       "goal 是唯一的语义步骤（内部走 Jev 局部循环）。",
        "params": _WINDOW_ARGS + [
            {"name": "steps", "type": "array", "required": True,
             "description": 'FlowStep 数组；action 的 act ∈ click/double_click/right_click/type/set_value/press/scroll/select/toggle/'
                            "expand/collapse/focus/invoke/launch/close 等；target 为 TargetSpec；可选 expect 后置条件",
             "schema": {"type": "array", "items": {"type": "object"}}},
            {"name": "values", "type": "object", "required": False, "description": "变量初值；步骤内用 ${name} 引用（白名单插值）"},
            {"name": "stop_on_error", "type": "boolean", "required": False, "description": "步骤失败即停止（默认 true）", "default": True},
            {"name": "session", "type": "string", "required": False, "description": "会话 id（默认 default）"},
            {"name": "dry_run", "type": "boolean", "required": False, "description": "只校验步骤与目标解析，不执行", "default": False},
        ],
    },
    {
        "name": "desktop_run",
        "description": "一句话目标 → 规划 LLM 有界 ReAct（观察→规划 1-3 步→执行→校验）。需要已配置 planner（baseUrl/model/keyEnv），"
                       "未配置返回 PLANNER_NOT_CONFIGURED。长任务建议用 CLI（无客户端超时压力）。",
        "params": [
            {"name": "goal", "type": "string", "required": True, "description": "自然语言目标"},
            {"name": "success_criteria", "type": "array", "required": False,
             "description": "验收条件列表（自然语言）；缺省时按『完成 goal 的直接可观察结果』处理并在结果标注未配置验收",
             "schema": {"type": "array", "items": {"type": "string"}}},
        ] + _WINDOW_ARGS + [
            {"name": "values", "type": "object", "required": False, "description": "供步骤引用的变量初值（如账号、文本）"},
            {"name": "session", "type": "string", "required": False, "description": "会话 id（默认 default）"},
        ],
    },
    {
        "name": "desktop_screenshot",
        "description": "截图（默认目标窗口区域；full_screen=true 整屏，可能含敏感信息）并保存 artifact；"
                       "return_image=true 时同时返回 MCP image 内容供多模态宿主直接看图",
        "params": _WINDOW_ARGS + [
            {"name": "full_screen", "type": "boolean", "required": False, "description": "整屏截图（默认 false）", "default": False},
            {"name": "return_image", "type": "boolean", "required": False, "description": "返回内嵌图像内容（MCP 下默认 true）", "default": False},
            {"name": "session", "type": "string", "required": False, "description": "会话 id（默认 default）"},
        ],
    },
    {
        "name": "desktop_clipboard",
        "description": "读/写/清系统剪贴板（UTF-8 文本）",
        "params": [
            {"name": "op", "type": "string", "required": True, "description": "get|set|clear"},
            {"name": "value", "type": "string", "required": False, "description": "op=set 时的文本内容"},
        ],
    },
]


def tool_schema(tool: dict) -> dict:
    """把 TOOLS 参数元数据转成 MCP inputSchema。"""
    props: dict = {}
    required: list[str] = []
    for p in tool["params"]:
        name = p["name"]
        sch: dict = dict(p.get("schema") or {})
        t = p["type"]
        if not sch:
            if t == "integer":
                sch = {"type": "integer"}
            elif t == "number":
                sch = {"type": "number"}
            elif t == "boolean":
                sch = {"type": "boolean"}
            elif t == "array":
                sch = {"type": "array"}
            elif t == "object":
                sch = {"type": "object"}
            else:
                sch = {"type": "string"}
        sch["description"] = p["description"]
        props[name] = sch
        if p.get("required"):
            required.append(name)
    return {"type": "object", "properties": props, "required": required}


def get_tool(name: str) -> dict | None:
    for t in TOOLS:
        if t["name"] == name:
            return t
    return None
