# jev-browser —— 浏览器控制工具（规划中）

> 状态：方案已确认，当前仅交付设计与开发计划，尚未实现、构建或发布。
> 方案版本：v0.2；核对日期：2026-09-24。本文的接口、配置和命令均为拟议契约，不是当前可运行功能。

## 目标

为 Agent、CLI 和 HTTP API 提供同一套浏览器控制能力：Playwright 执行操作，Jev 处理页面语义判断，可选的大模型规划器处理完整任务。优先缩短可靠完成任务的总时间，而不是单次请求的返回时间。

沿用仓库“核心逻辑与提供方式分离”的规范：`core` 是业务和工具元数据的单一事实来源；`cli`、`mcp`、`api` 是薄适配层。参考项目为 Ying-Kai-Liao/jev-browser，不直接把其整个服务套一层转发。

## 已确认的设计

| 项目 | 决定 |
| --- | --- |
| 默认浏览器 | 接管用户已打开的日常 Google Chrome，复用既有登录状态和标签页 |
| 默认显示模式 | 有头；无头仅适用于工具新启动的浏览器 |
| 配置渠道 | 环境变量和 JSON 配置文件；CLI 可提供显式覆盖 |
| 浏览器切换 | 可显式改为 Playwright 管理的 Chromium；不在连接失败时静默换浏览器 |
| `execute`（A） | 接受明确步骤或单一、可验证的结果目标；不调用内部规划大模型 |
| `run`（B） | 接受需要拆解的完整目标，使用可选规划器，再复用同一执行引擎 |
| 调用入口 | Agent/MCP、CLI、HTTP API 均支持两种模式，不按入口决定 A/B |
| 规划负责人 | 一个任务阶段只有一个；外部 Agent 已有计划时，不在内部重复规划 |
| 首版写入边界 | 只读 + 下载 + 低风险确定性写；发送/购买/删除等高风险动作一律暂停，待可信审批通道（P5）验收后再开放 |
| 退出行为 | 断开接管连接，不关闭用户 Chrome、既有 context 或既有标签页 |

“Playwright 模拟的浏览器”在本方案中解释为 Playwright 安装、管理的真实 Chromium 浏览器，不是 DOM 模拟器。首版不承诺 Firefox、WebKit 或视觉坐标式通用桌面控制。

## 文档导航

1. [DESIGN.md](DESIGN.md)：架构、浏览器连接、任务契约、配置、安全与效率设计。
2. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)：分阶段工作、依赖、验收门槛、基准测试和交付清单。
3. [RESEARCH.md](RESEARCH.md)：本地规范、参考项目差异、官方资料、假设与待验证项。

## 两种模式如何选择

```text
Agent / CLI / HTTP API
          │
    同一组输入/输出契约
          │
     ┌────┴─────┐
  execute       run
  已有步骤      完整目标
  不做总规划    可选大模型规划器
     └────┬─────┘
       执行引擎
          │
    确定性操作 → Playwright
    页面语义判断 → Jev → Playwright
          │
     结果验证 / 暂停 / 恢复
```

- 已知流程直接 `execute`，不要为了“智能”再规划一次。
- 单个页面目标也可 `execute`，其内部允许多轮 Jev 判断与操作。
- 复杂目标用 `run`，在工具内部处理计划调整；不要让外部 Agent 同时重复拆解同一任务。
- 两种模式都支持批量步骤、逐步验证、长连接复用和失败后返回证据。
- 不承诺 A 或 B 永远更快；在相同成功率、安全约束、浏览器状态和计时范围下测试。

## 默认接管方式与边界

优先验证 Chrome 原生授权远程调试 + Playwright CDP 直连；不是默认安装扩展，也不是每一步再经过另一个浏览器 MCP 服务。

官方资料支持 Chrome 144 及以上通过 `chrome://inspect/#remote-debugging` 开启并授权调试连接；Playwright 的固定版本实现也提供了 Chrome channel 端点发现。此方案仍须通过 P0 的本机验证，不把文档证据等同于你的电脑已经可用。详见 [研究记录 S3—S6](RESEARCH.md)。

必须明确：

- 工具不能在未授权情况下无条件接管任意已打开的 Chrome。
- 传统 `--remote-debugging-port` 启动方式受默认用户数据目录限制，不能把它当作日常主配置文件的通用接管方案。
- 已打开的有头 Chrome 不能因配置 `headless=true` 而变成无头。需要显式选择 `launch`，启动另一个实例。
- 新启动的 Chromium/独立 Chrome 不会自动继承日常 Chrome 的全部登录状态；不复制主 profile、不导出全部 Cookie。

## 配置示意（拟议，尚未实现）

默认：

```json
{
  "schemaVersion": 1,
  "browser": {
    "mode": "attach",
    "engine": "chrome",
    "headless": false,
    "attach": {
      "endpoint": "chrome",
      "noDefaults": true
    }
  },
  "planner": {
    "enabled": false
  }
}
```

切换为工具管理的无头 Chromium：

```json
{
  "schemaVersion": 1,
  "browser": {
    "mode": "launch",
    "engine": "chromium",
    "headless": true
  }
}
```

PowerShell 环境变量示意（可直接覆盖上面的配置，未激活的 attach 子对象保留但不使用）：

```powershell
$env:JEV_BROWSER_MODE = "launch"
$env:JEV_BROWSER_ENGINE = "chromium"
$env:JEV_BROWSER_HEADLESS = "true"
```

attach/launch 配置按分支存放，只启用当前 mode 对应参数，无需为切换环境变量删除原配置；未知字段仍报错，attach + headless=true 仍不能隐式变成 launch。两种引擎使用不同工具 profile，避免混写。

默认不许可任何网站：实际使用需在可信配置中声明 `safety.allowedOrigins`；云模型可见的域另外放入 `safety.modelOrigins`。示例：只读 Example Domain 时可配置 `allowedOrigins: ["https://example.com"]`，纯确定性步骤保持 `modelOrigins: []`。API/MCP 任务只能从宿主已许可域中选子集，不能自行扩大权限。

开启自主模式需另外配置规划模型；Jev 的 API key 不能代替规划模型凭据。缺少规划器时 `run` 返回明确错误，不自动猜模型、供应商或费用预算。

## 拟议使用入口

以下命令需待实现和构建后才能使用；目前不要执行 `build jev-browser` 或把它加入生产 MCP 配置。

```powershell
# 在 tools/jev-browser 中：诊断默认接管环境
node cli/dist/index.js doctor

# 运行已定义步骤，不进行内部任务规划
node cli/dist/index.js execute --file examples/read-page.flow.json --url "https://example.com"

# 内部规划：先授权业务站点/模型外发，再指定目标页和验收条件
node cli/dist/index.js run --page "page-from-pages" --goal "查找本月可下载的发票，逐个下载并记录失败项" --success "处理范围最多20项；每项都有已保存文件或明确失败原因；报告是否还有未处理项"
# --success 是人类可读条件，工具会校验/必要时澄清，不等于模型可以自行宣布完成。

# 长驻本地 HTTP 服务：供 API、本机 CLI、可选 MCP 客户端复用同一会话
node api/dist/index.js --config "D:\config\jev-browser.json"

# 在仓库根目录中，统一入口仍然是 MCP
# node bin/tool-launcher.js jev-browser
```

## 当前交付与下一步

本次仅新增文档与索引，不创建 `package.json`、依赖、运行入口或假实现。因此启动器 `list` 暂时不会把这个目录识别成可运行工具。

下一步是 **P0：接管可行性与保护性验证**，尤其验证未选中标签页的原生对话框不被自动处理、下载文件在断开后仍可用。通过后再搭建 `core + cli + mcp + api` 工作区，先完成 A 的执行引擎，再增加 B 的可选规划器。

本轮修订还补齐了 profile 级暂停预约、取消/恢复竞态、持久化动作账本、任务级验收和独立审批边界。审查发现与验证记录见 [RESEARCH.md](RESEARCH.md)；它们是设计约束，不是已经通过的运行测试。
