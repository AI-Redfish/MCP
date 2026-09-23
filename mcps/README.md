# mcps/ —— MCP 子服务目录

本目录存放各个 MCP 工具。每个子目录是一个独立的 **core + cli + mcp 三包工作区**（pnpm/npm workspace + TypeScript 工程引用），例如 `server-a`：

```
mcps/
└── server-a/                  # 子服务名（即启动器参数）
    ├── core/                  # 核心逻辑：纯函数 + 工具元数据（无任何传输依赖）
    │   ├── src/index.ts
    │   ├── package.json       # @ai-redfish/server-a-core
    │   └── tsconfig.json
    ├── cli/                   # CLI 适配器：把 core 工具暴露为命令行命令
    │   ├── src/index.ts
    │   ├── package.json       # @ai-redfish/server-a-cli（bin: server-a-cli）
    │   └── tsconfig.json
    └── mcp/                   # MCP 适配器：把 core 工具暴露为 stdio MCP Server
        ├── src/index.ts
        ├── package.json       # @ai-redfish/server-a-mcp
        └── tsconfig.json
    ├── package.json           # 工作区根（workspaces、build/start 脚本、typescript devDep）
    ├── pnpm-workspace.yaml    # pnpm workspace 定义（npm 用户走 package.json 的 workspaces 字段）
    ├── .npmrc                 # pnpm 的 link-workspace-packages=true
    ├── tsconfig.base.json     # 共享编译选项
    └── tsconfig.json          # 工程引用入口（tsc -b 按依赖顺序构建）
```

## 为什么要这样分层

"逻辑一样、对外方式不同"是典型的核心逻辑与适配层分离场景：

- `core` 只写一次纯函数与工具元数据（`TOOLS`），不感知 MCP 协议或命令行；
- `mcp` 适配器只做协议注册（zod schema + handler 转发到 core）；
- `cli` 适配器只做参数解析（依据 `TOOLS` 自动生成帮助与校验，转发到 core）。

收益：新增工具只写一次核心实现；两个入口行为天然一致；重复代码趋近于零。

## 本地开发

```bash
cd mcps/server-a
pnpm install            # 或 npm install（两者都支持 workspaces）
pnpm build              # 或 npm run build（实际执行 tsc -b，按 core -> cli/mcp 顺序构建）

# MCP 方式（stdio）
node mcp/dist/index.js

# CLI 方式（调用的是同一批工具）
node cli/dist/index.js list
node cli/dist/index.js echo "hello"
node cli/dist/index.js echo --message hello
```

也可以从仓库根目录让启动器代劳（自动 install + build + 启动）：

```bash
node bin/mcp-launcher.js server-a        # MCP 方式
node bin/mcp-launcher.js build server-a  # 只安装并构建
```

## 新增一个工具（以 server-a 为例）

1. `core`：实现纯函数（如 `hello()`），并在 `TOOLS` 中登记名称/描述/参数；
2. `core`：在 `runTool` 的分发中补一个 case；
3. `mcp`：用 `server.tool(...)` + zod 注册，名称与描述复用 `TOOLS` 元数据，handler 调用 core 函数；
4. `cli`：无需改动——用法、`list`、参数校验全部由 `TOOLS` 自动生成；
5. 重新构建：`pnpm build`（或仓库根 `node bin/mcp-launcher.js build server-a`）。

## 新增一个子服务

1. 复制 `server-a/` 为新目录（目录名即服务名，只允许字母、数字、`.`、`_`、`-`）；
2. 全局替换包名 `@ai-redfish/server-a-*` 与 `core` 中的 `SERVER_NAME`；
3. 在子服务根 `package.json` 的 `description` 写一句话简介（启动器 `list` 会展示）；
4. `node bin/mcp-launcher.js build <名字>` 构建并确认。

## 注意事项

- stdio 传输下 **stdout 是 MCP 协议通道**：mcp 适配器自身的日志必须写 stderr（`console.error`）；CLI 适配器没有这个限制，结果正常打印到 stdout；
- 子服务通过环境变量 `MCP_SERVER_NAME` 可获知自己的服务名；
- 需要Node.js >= 18；包管理器优先 pnpm，未安装时回退 npm（两种管理器都支持 workspaces）。
