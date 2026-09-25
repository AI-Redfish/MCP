"""vlm 档（DESIGN ADR-01）：降采样截图 → OpenAI 兼容多模态模型 → 结构化元素清单。

坐标精度天然低于 OCR/UIA，只用于定位意图；未单独配置时回落 planner 端点（单 key 便利路径，
配置里注明数据将发往该端点）。
"""

import base64
import json
import re

import httpx

from ..errors import err
from .model import TextBlock

PROMPT = (
    "你是 Windows 桌面截图分析器。列出图中可见的可交互元素与关键文字，只输出 JSON：\n"
    '{"elements":[{"name":"元素上的文字或简短描述","type":"button|input|link|text|icon|other",'
    '"bbox":[left,top,right,bottom],"action":"click|type|select|other"}]}\n'
    "要求：bbox 为相对截图左上角的像素坐标；按版面从上到下、从左到右排序；"
    "不要编造图里没有的元素；最多 80 个。"
)


def describe(cfg: dict, image_bytes: bytes, *, goal: str | None = None, timeout_s: float = 45.0) -> list[TextBlock]:
    """image_bytes 应为已降采样的 JPEG（见 screenshot.downscale_jpeg）。"""
    vlm = cfg["observation"]["vlm"]
    base_url = vlm.get("baseUrl")
    model = vlm.get("model")
    key_env = vlm.get("apiKeyEnv")
    if not base_url or not model:
        planner = cfg["planner"]
        base_url, model, key_env = planner.get("baseUrl"), planner.get("model"), planner.get("apiKeyEnv")
        if not base_url or not model:
            raise err("PROVIDER_ERROR",
                      "vlm 档未配置且 planner 也未配置：请在配置中设置 observation.vlm 或 planner 的 baseUrl/model "
                      "（注意：截图将发送到该端点）")
    import os
    key = os.environ.get(key_env or "", "")
    if not key:
        raise err("PROVIDER_ERROR", f"缺少 VLM API key（环境变量 {key_env}）")

    b64 = base64.b64encode(image_bytes).decode("ascii")
    user_content = [
        {"type": "text", "text": (f"任务目标（供参考）：{goal}\n" if goal else "") + PROMPT},
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
    ]
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "只输出 JSON，不要多余文字。"},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,
        "max_tokens": 2048,
    }
    url = base_url.rstrip("/") + "/chat/completions"
    try:
        resp = httpx.post(url, json=body, timeout=timeout_s,
                          headers={"authorization": f"Bearer {key}"})
    except httpx.HTTPError as e:
        raise err("PROVIDER_ERROR", f"VLM 请求失败: {type(e).__name__}: {e}", retryable=True)
    if resp.status_code != 200:
        raise err("PROVIDER_ERROR", f"VLM 端点 {resp.status_code}: {resp.text[:200]}",
                  retryable=resp.status_code in (429, 500, 502, 503, 504))
    try:
        content = resp.json()["choices"][0]["message"]["content"] or ""
    except Exception as e:
        raise err("PROVIDER_ERROR", f"VLM 响应解析失败: {e}")
    return parse_elements(content)


def parse_elements(content: str) -> list[TextBlock]:
    """解析 VLM 结构化输出为 TextBlock（bbox 即窗口相对坐标）。"""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", content)
    candidate = fenced.group(1) if fenced else content
    start, end = candidate.find("{"), candidate.rfind("}")
    if start < 0 or end <= start:
        raise err("PROVIDER_ERROR", "VLM 输出中找不到 JSON 对象")
    try:
        data = json.loads(candidate[start:end + 1])
    except ValueError as e:
        raise err("PROVIDER_ERROR", f"VLM JSON 解析失败: {e}")
    elements = data.get("elements")
    if not isinstance(elements, list):
        raise err("PROVIDER_ERROR", "VLM 输出缺少 elements 数组")
    blocks: list[TextBlock] = []
    for el in elements[:80]:
        if not isinstance(el, dict):
            continue
        bbox = el.get("bbox")
        name = str(el.get("name", "")).strip()
        if not name or not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            l, t, r, b = (int(round(float(x))) for x in bbox)
        except (TypeError, ValueError):
            continue
        blocks.append(TextBlock(ref="", text=name, rel_rect=(l, t, r, b), confidence=0.5, source="vlm"))
    return blocks
