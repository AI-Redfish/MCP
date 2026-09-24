# jev-desktop —— Windows 桌面软件控制工具（规划中）

> 状态：方案已确认，当前仅交付设计与开发计划，尚未实现、构建或发布。
> 方案版本：v0.1；核对日期：2026-09-24。本文的接口、配置和命令均为拟议契约，不是当前可运行功能。

## 目标

基于「规划 LLM + Jev 判断」控制 Windows 桌面上的**任意软件**：UIA 辅助功能树读结构、Jev 做局部语义判断、规划 LLM 做任务拆解、UIA Pattern 与 SendInput 做动作。为 Agent（MCP）和 CLI 提供同一套能力，不做前台页面。优先缩短可靠完成任务的总时间，而不是单次请求的返回时间。

沿用仓库"核心逻辑与提供方式分离"的规范：`core` 是业务和工具元数据的单一事实来源；`cli`、`mcp` 是薄适配层。参考项目：jev-chat/jev-chat-jarvis（Jev+LLM 分工、provider 预设、安全边界思想）、lahfir/agent-desktop（快照+ref、渐进骨架遍历、headless 语义动作；其 Windows 支持为 Planned，仅借鉴范式，不直接复用）。

## 已确认的设计

| 项目 | 决定 | 来源 |
| --- | --- | --- |
| 目标应用 | 标准软件与自绘界面混合、不可预知 → UIA 语义 + 截图/OCR/视觉双通道混合架构 | 用户拍板 |
| 模型配置 | 规划器与观察提供者全部可配置可降级（`uia_tree` → `ocr` → `vlm`），OpenAI 兼容协议 + 预设 | 用户拍板 |
| 安全姿态 | A：无风险门禁，动作全放行；仅保留动作账本与 `--dry-run`（纯观测，不拦截） | 用户拍板 |
| 实现语言 | Python ≥ 3.10；UIA 主选 `uiautomation`，备选 `pywinauto`，P0 实测锁定 | 技术选型 |
| OCR | 首版仅 `rapidocr`（v3 统一包）；Windows OCR 为后续优化 | 技术选型 |
| Jev 接入 | 官方 `typesafe-sdk` + TypeSafe 协议预设（bocha/typesafe/zen/custom），与 jarvis 预设同构 | 技术选型 |
| 运行平台 | Windows 10/11 原生（工具进程不走 WSL）；DPI 感知强制开启 | 约束 |
| 首版形态 | `execute` / `run` 双模式共用执行引擎；同步返回；无任务持久化、无 HTTP API | 设计 |

## 架构一览

```text
        MCP 客户端（Agent）          CLI（人/脚本）
                 │                      │
           mcp_server.py             cli.py        ← 薄适配器
                 └─────────┬──────────┘
                    core（TOOLS 元数据 + 引擎）
                           │
        ┌──────────────────┼──────────────────┐
   execute 模式        run 模式            doctor
 （外部步骤，无规划） （goal → 规划 LLM        │
        └───────┬───────┘   有界 ReAct）       │
           执行引擎（预算 / 状态机 / 动作账本）
                │                 │
        观察通道 Observe       动作通道 Act
   uia_tree │ ocr │ vlm     UIA Pattern │ SendInput │ 窗口管理
                │
     Jev 判断：元素选择 Choice / 校验 Noul（并行）
```

## 两种模式如何选择

- 已知流程、能写明确步骤 → `execute`：确定性动作零模型调用；步骤内允许 `goal` 型语义步骤（Jev 局部循环）。
- 只有一句话目标 → `run`：需要已配置规划 LLM；工具内部做有界 ReAct（观察 → 规划 1–3 步 → 执行 → 校验），预算硬上限。
- 两者共用同一执行引擎与输出契约；不新增模型请求来猜该用哪个入口，调用者显式选择。

## 拟议使用入口（未实现，勿执行）

```powershell
# 诊断环境（UIA/OCR/DPI/provider 连通性）
python tools/jev-desktop/cli.py doctor

# 观察一个窗口（uia/ocr/vlm/auto）
python tools/jev-desktop/cli.py snapshot --app "记事本"

# 执行明确步骤（JSON 文件或内联）
python tools/jev-desktop/cli.py execute --file examples/notepad.flow.json

# 一句话目标（需已配置规划 LLM）
python tools/jev-desktop/cli.py run --app "记事本" --goal "写一段自我介绍并保存到桌面 hello.txt"

# MCP 方式（实现后）：.mcp.json 配置 args 追加 "jev-desktop"
# npx github:AI-Redfish/Tool jev-desktop
```

MCP 工具拟为：`desktop_doctor / desktop_windows / desktop_snapshot / desktop_act / desktop_execute / desktop_run / desktop_screenshot / desktop_clipboard`。

## 配置示意（拟议，尚未实现）

```jsonc
{
  "schemaVersion": 1,
  "observation": { "level": "auto" },
  "jev": { "provider": "bocha", "apiKeyEnv": "TYPESAFE_API_KEY" },
  "planner": {
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKeyEnv": "JEV_DESKTOP_PLANNER_API_KEY"
  },
  "runtime": { "runTimeoutMs": 120000, "maxSteps": 40 }
}
```

配置优先级：CLI 参数 > 环境变量（`JEV_DESKTOP_*`）> `%LOCALAPPDATA%\AI-Redfish\jev-desktop\config.json` > 默认值。字段明细见 [技术设计 §11](DESIGN.md)。

## 文档导航

1. [DESIGN.md](DESIGN.md)：架构决策（ADR）、三档观察通道、动作通道、Jev/规划器设计、契约、配置、限制。
2. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)：P0 选型验证门 → P1..P6 分阶段交付、退出门槛。
3. [RESEARCH.md](RESEARCH.md)：参考项目差异、公开来源索引、已核实事实、假设与待验证项。

## 当前交付与下一步

本次仅新增文档与索引，不创建 `launcher.json`、依赖清单、运行入口或假实现。启动器 `list` 不会把这个目录识别成可运行工具。

下一步是 **P0：选型验证与目标应用实测**（阻塞门）：uiautomation vs pywinauto 六应用矩阵、UIA 卡死防护、DPI 坐标一致性、rapidocr 速度与中文准确率、typesafe-sdk 连通、规划器 JSON 输出、快照 token 体积。通过后再搭建 `core + cli + mcp` 骨架，先 execute 后 run。
