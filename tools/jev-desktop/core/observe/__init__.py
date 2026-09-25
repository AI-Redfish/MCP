"""观察通道统一入口（DESIGN ADR-01 / §4）。

auto 降级：UIA 探测 → uia；不可用落 ocr；ocr 结果为空且 vlm 已配置时返回提示，
由调用者显式升档，不静默升档（费用可见）。三档产出统一快照格式（文本 + refs）。
"""

import time

from ..errors import JevError, err
from ..winapi import window_rect
from . import ocr as ocr_mod
from . import screenshot as shot
from . import uia_tree
from . import vlm as vlm_mod
from .model import Snapshot, TextBlock, estimate_tokens


def select_level(cfg: dict, worker, hwnd: int, requested: str) -> str:
    """决定实际档位（auto 逻辑）。"""
    level = requested or cfg["observation"]["level"]
    if level != "auto":
        return level
    try:
        uia = worker.import_uia()

        def _probe():
            return uia_tree.probe_uia(uia, hwnd)

        if worker.call(_probe, 8.0, "UIA 可用性探测"):
            return "uia"
    except JevError as e:
        if e.code not in ("UIA_UNAVAILABLE", "TIMEOUT"):
            raise
    return "ocr"


def take_snapshot(ctx, hwnd: int, window_info: dict, *, level: str | None = None,
                  root_ref: str | None = None, depth: int | None = None,
                  max_elements: int | None = None, save_artifact: bool = False,
                  image_bytes_out: list | None = None) -> Snapshot:
    """对窗口做一次快照。ctx 需要：cfg/worker/registry/artifacts_dir/ledger/metrics。"""
    t0 = time.monotonic()
    cfg = ctx.cfg
    worker = ctx.worker
    obs_cfg = cfg["observation"]
    lvl = select_level(cfg, worker, hwnd, level)
    from ..session import new_snapshot_id
    sid = new_snapshot_id()

    notes: list[str] = []
    snap = Snapshot(id=sid, level=lvl, window=dict(window_info))

    if lvl == "uia":
        uia = worker.import_uia()
        max_depth = depth or obs_cfg["uia"]["maxDepth"]
        cap = max_elements or obs_cfg["uia"]["maxElements"]
        timeout_s = max(5.0, cfg["runtime"]["snapshotTimeoutMs"] / 1000)

        root_rid = None
        if root_ref:
            info = ctx.registry.lookup(root_ref)
            if not info:
                raise err("STALE_REF", f"下钻根 ref {root_ref} 不在当前会话中；请先对目标窗口重新快照")
            root_rid = info.get("runtimeId")

        def _do():
            win_ctrl = uia_tree.window_control(uia, hwnd)
            return uia_tree.walk_tree(uia, win_ctrl, snapshot_id=sid, hwnd=hwnd, pid=window_info.get("pid", 0),
                                      max_depth=max_depth, max_elements=cap)

        elements, lines, truncated = worker.call(_do, timeout_s, f"UIA 树遍历（深度{max_depth}）")
        snap.elements = elements
        snap.truncated = truncated
        interactive = [e for e in elements if e.interactive]
        snap.text = uia_tree.render_text(sid, window_info, lines, level=lvl, truncated=truncated,
                                         notes=[f"交互元素 {len(interactive)}/{len(elements)}"])
        if save_artifact:
            try:
                screen = shot.grab_rect(worker, window_rect(hwnd))
                snap.image_path = worker.call(lambda: shot.save_artifact(ctx.artifacts_dir, screen, "snap-uia"),
                                              10.0, "保存观察截图")
            except JevError:
                pass
        if truncated:
            notes.append("快照被截断：优先用 root 参数下钻；token 预算参考 " + str(estimate_tokens(snap.text)))

    elif lvl in ("ocr", "vlm"):
        rect = window_rect(hwnd)
        if not rect:
            raise err("WINDOW_LOST", f"窗口 {hwnd} 矩形获取失败（可能已最小化或关闭）；请先 focus/restore 再观察")
        if rect[2] - rect[0] < 4 or rect[3] - rect[1] < 4:
            raise err("WINDOW_LOST", f"窗口 {hwnd} 矩形异常 {rect}")
        screen = shot.grab_rect(worker, rect)
        # ocr/vlm 档截图即证据，始终落 artifact（仅目标窗口区域，非整屏）
        try:
            snap.image_path = worker.call(lambda: shot.save_artifact(ctx.artifacts_dir, screen, f"snap-{lvl}"),
                                          10.0, "保存观察截图")
        except JevError:
            pass
        if image_bytes_out is not None:
            image_bytes_out.append(shot.to_png_bytes(screen))
        if lvl == "ocr":
            png = shot.to_png_bytes(screen)

            def _ocr():
                return ocr_mod.recognize(png)

            blocks = worker.call(_ocr, max(15.0, cfg["runtime"]["snapshotTimeoutMs"] / 1000), "OCR 识别")
            ocr_mod.assign_refs(blocks, sid)
            snap.blocks = blocks
            lines = ocr_mod.render_lines(sid, blocks)
            if not blocks:
                vlm_ready = _vlm_configured(cfg)
                if vlm_ready:
                    notes.append("OCR 未得到文字块：该窗口可能是自绘/图形界面，建议显式 level=vlm 升档（费用可见，不自动升档）")
                else:
                    notes.append("OCR 未得到文字块；如需视觉理解请配置 observation.vlm 后显式 level=vlm")
            snap.text = _render_block_text(sid, window_info, lines, lvl, "文字块")
        else:
            jpeg, sw, sh = shot.downscale_jpeg(screen)
            blocks = vlm_mod.describe(cfg, jpeg, goal=None)
            # 缩放回窗口相对原始坐标
            try:
                ow, oh = screen.size
            except Exception:
                ow = oh = 0
            fx = (ow / sw) if sw else 1.0
            fy = (oh / sh) if sh else 1.0
            for b in blocks:
                l, t, r, bo = b.rel_rect
                b.rel_rect = (int(l * fx), int(t * fy), int(r * fx), int(bo * fy))
            ocr_mod.assign_refs(blocks, sid)
            snap.blocks = blocks
            lines = ocr_mod.render_lines(sid, blocks)
            snap.text = _render_block_text(sid, window_info, lines, lvl, "VLM 元素")
    else:  # pragma: no cover - config 已校验
        raise err("INVALID_PARAMS", f"未知观察档位 {lvl}")

    snap.notes.extend(notes)
    snap.elapsed_ms = int((time.monotonic() - t0) * 1000)
    ctx.registry.put_snapshot(snap.to_dict(include_refs=True))
    return snap


def _vlm_configured(cfg: dict) -> bool:
    import os
    vlm = cfg["observation"]["vlm"]
    if vlm.get("baseUrl") and vlm.get("model"):
        return True
    if cfg["planner"].get("baseUrl") and cfg["planner"].get("model"):
        key_env = vlm.get("apiKeyEnv") or cfg["planner"]["apiKeyEnv"]
        return bool(os.environ.get(key_env or ""))
    return False


def _render_block_text(sid: str, window: dict, lines: list[str], level: str, kind: str) -> str:
    head = (f'# 快照 @{sid} 窗口:"{window.get("title", "")}" pid={window.get("pid")} '
            f"hwnd={window.get('hwnd')} level={level} {kind}={len(lines)}")
    body = "\n".join(lines) if lines else "（无文字块）"
    tail = "# 动作引用: click 的 target={\"kind\":\"ref\",\"ref\":\"@...:bN\"}（取块中心坐标）"
    return "\n".join([head, body, tail])
