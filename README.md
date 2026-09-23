# AI-Redfish MCP 集合

当前项目是我的 **MCP 集合项目**：仓库根目录是一个「启动器」，`mcps/` 目录下集中放置各个 MCP 子服务。每个子服务采用 **core + cli + mcp 三包工作区**结构：核心逻辑与适配层分离，**同一个工具既能以 MCP Server 方式提供，也能以 CLI 命令方式提供**，两种入口共享同一份实现。

用户通过一个统一入口（`npx github:AI-Redfish/MCP 子服务名`）即可按需启动任意一个子服务，无需单独安装、单独配置仓库。

## 设计理念：核心逻辑与适配层分离

"逻辑一样、对外方式不同"是典型的核心逻辑与适配层分离场景——把业务逻辑沉到 `core`（纯函数/类），CLI 与 MCP 只是两种不同的适配器：

```
                    ┌────────────────────┐
                    │       core         │   纯函数 / 工具元数据（无任何传输依赖）
                    └─────────┬──────────┘
              ┌───────────────┴───────────────┐
      ┌───────┴────────┐              ┌───────┴────────┐
      │   cli 适配器    │              │   mcp 适配器    │
      │ 命令行调用方式   │              │ stdio MCP 协议  │
      └────────────────┘              └────────────────┘
```

- **大幅减少重复代码**：业务实现只写一次，两个适配器都是薄薄一层转发；
- **行为天然一致**：工具描述、参数、实现同源（core 的 `TOOLS` 元数据是单一事实来源）；
- **方便维护**：改核心逻辑只动 `core`，改协议只动对应适配器，互不影响。

## 目录结构

```
.
├── bin/
│   └── mcp-launcher.js    # 启动器入口：解析参数 -> 按需安装/构建 -> 拉起子服务
├── mcps/                  # 所有 MCP 子服务（每个子目录 = 一个工具工作区）
│   └── server-a/          # 示例工具（echo / now）
│       ├── core/          # 核心逻辑：纯函数 + 工具元数据（@ai-redfish/server-a-core）
│       ├── cli/           # CLI 适配器（@ai-redfish/server-a-cli，bin: server-a-cli）
│       ├── mcp/           # MCP 适配器（@ai-redfish/server-a-mcp，stdio MCP Server）
│       ├── package.json   # server-a 工作区根（workspaces + build/start 脚本）
│       ├── pnpm-workspace.yaml
│       └── tsconfig.json  # TypeScript 工程引用（tsc -b 按依赖顺序构建）
├── doc/                   # 项目文档（MCP 学习笔记等）
└── package.json           # 仓库根 package.json，只负责"启动器"这一件事
```

## 在客户端中使用（.mcp.json 配置）

当前项目是我 mcp 集合项目，可以让用户添加到如下配置文件中：

```json
{
  "mcpServers": {
    "你的服务器名": {
      "command": "npx",
      "args": ["-y", "github:AI-Redfish/MCP"]
    }
  }
}
```

这个配置文件 `.mcp.json` 放到 `.agents` 的 `mcps` 目录下（即 `<你的项目根>/.agents/mcps/.mcp.json`）。

由于本仓库是"启动器 + 子服务"结构，请通过 `args` 末尾追加子服务名来指定要启动的服务，例如启动 `server-a`：

```json
{
  "mcpServers": {
    "你的服务器名": {
      "command": "npx",
      "args": ["-y", "github:AI-Redfish/MCP", "server-a"]
    }
  }
}
```

> 提示：不同的子服务可以各配一条 `mcpServers` 条目，`args` 里写各自的子服务名即可。

## 启动器用法

仓库根目录的 `package.json` 只做一件事：接收参数，然后动态加载 `mcps/` 里的服务器。用户运行：

```bash
npx github:AI-Redfish/MCP server-a
```

启动器会根据 `server-a` 参数：

1. 定位 `mcps/server-a/` 目录；
2. 若依赖尚未安装（`node_modules` 缺失），自动执行 `pnpm install`（未装 pnpm 时回退 `npm install`）；
3. 若 MCP 入口尚未构建（`mcp/dist` 缺失），自动执行 `tsc -b` 构建；
4. 以子进程启动 `mcp/dist/index.js`，并透传 stdin/stdout（MCP stdio 协议通道）、stderr 及退出码。

> 安装与构建过程的日志全部被重定向到 stderr，不会污染 stdout 协议通道。

其他命令：

```bash
# 列出所有可用的子服务
npx github:AI-Redfish/MCP list

# 手动安装并构建某个子服务（开发调试用）
npx github:AI-Redfish/MCP build server-a

# 本地开发调试
npm run list
node bin/mcp-launcher.js server-a
```

## 以 CLI 方式使用同一个工具

每个子服务除 MCP 入口外，还自带一个 CLI 适配器，调用的是同一份核心逻辑：

```bash
cd mcps/server-a
pnpm install            # 或 npm install
pnpm build              # 或 npm run build（实际执行 tsc -b）

node cli/dist/index.js list                 # 列出可用工具
node cli/dist/index.js echo "hello"         # 位置参数
node cli/dist/index.js echo --message hi    # 命名参数
node cli/dist/index.js now
npm run start:cli -- echo "hello"                    # 等价写法
```

## 可用的 MCP 子服务

| 服务名 | 说明 | MCP 工具 | CLI 命令 |
| --- | --- | --- | --- |
| `server-a` | 示例工具工作区（core + cli + mcp 三包） | `echo`、`now` | `server-a-cli` |

## 如何新增一个子服务

1. 在 `mcps/` 下新建子目录（目录名即服务名，只允许字母、数字、`.`、`_`、`-`），按 `server-a/` 的 `core|cli|mcp` 结构搭建（最简单的做法是整目录复制后改名）；
2. 在 `core/src/index.ts` 中实现纯函数，并登记到 `TOOLS` 元数据；
3. 在 `mcp` 适配器中用 `server.tool(...)` + zod 注册（描述复用 `TOOLS` 元数据）；CLI 适配器无需改动——用法、`list`、参数校验都由 `TOOLS` 自动生成；
4. 在子服务根目录写好 `package.json` 的 `description`（启动器 `list` 会展示）；
5. 运行 `npx github:AI-Redfish/MCP build <名字>` 构建并确认。

详见 [mcps/README.md](mcps/README.md)。

## 注意事项

- stdio 传输下 **stdout 是 MCP 协议通道**：无论是启动器还是子服务，日志都必须输出到 stderr（`console.error`），否则会破坏协议通信；CLI 适配器没有这个限制，结果正常打印到 stdout；
- 启动器只负责分发（安装/构建/拉起），不包含任何业务逻辑；业务能力全部在各子服务的 `core` 内实现；
- 需要Node.js >= 18；安装/构建优先使用 pnpm，未安装时自动回退 npm。
