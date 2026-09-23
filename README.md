# AI-Redfish MCP 集合

当前项目是我的 **MCP 集合项目**：仓库根目录是一个「启动器」，`mcps/` 目录下集中放置各个 MCP 子服务的代码。用户通过一个统一入口（`npx github:用户名/仓库名 子服务名`）即可按需启动任意一个子服务，无需单独安装、单独配置仓库。

## 目录结构

```
.
├── bin/
│   └── mcp-launcher.js    # 启动器入口：解析参数 -> 定位 mcps/<名称> -> 拉起子进程
├── mcps/                  # 所有 MCP 子服务代码（每个子目录 = 一个服务）
│   └── server-a/          # 示例子服务（echo / now 两个演示工具）
├── doc/                   # 项目文档（MCP 学习笔记等）
└── package.json           # 根 package.json，只负责"启动器"这一件事
```

## 在客户端中使用（.mcp.json 配置）

当前项目是我 mcp 集合项目，可以让用户添加到如下配置文件中：

```json
{
  "mcpServers": {
    "你的服务器名": {
      "command": "npx",
      "args": ["-y", "github:你的用户名/你的仓库名"]
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
      "args": ["-y", "github:你的用户名/你的仓库名", "server-a"]
    }
  }
}
```

> 提示：不同的子服务可以各配一条 `mcpServers` 条目，`args` 里写各自的子服务名即可。

## 启动器用法

仓库根目录的 `package.json` 只做一件事：接收参数，然后动态加载 `mcps/` 里的服务器。用户运行：

```bash
npx github:你的用户名/你的仓库名 server-a
```

启动器会根据 `server-a` 参数：

1. 定位 `mcps/server-a/` 目录；
2. 若该子服务声明了自己的 `dependencies` 且尚未安装，先自动 `npm install`；
3. 以子进程启动其 `index.js`，并透传 stdin/stdout（MCP stdio 协议通道）、stderr 及退出码。

其他命令：

```bash
# 列出所有可用的子服务
npx github:你的用户名/你的仓库名 list

# 本地开发调试
npm run list
node bin/mcp-launcher.js server-a
```

## 可用的 MCP 子服务

| 服务名 | 说明 |
| --- | --- |
| `server-a` | 示例服务，提供 `echo`、`now` 两个演示工具 |

## 如何新增一个子服务

1. 在 `mcps/` 下新建子目录（目录名即服务名，只允许字母、数字、`.`、`_`、`-`）；
2. 创建 `index.js` 作为入口，实现标准 stdio MCP Server；
3. （可选）创建 `package.json`：声明 `dependencies` 后，首次启动会自动安装依赖；
4. 运行 `node bin/mcp-launcher.js list` 确认识别成功。

详见 [mcps/README.md](mcps/README.md)。

## 注意事项

- stdio 传输下 **stdout 是 MCP 协议通道**：无论是启动器还是子服务，日志都必须输出到 stderr（`console.error`），否则会破坏协议通信；
- 启动器只负责分发，不包含任何业务逻辑；业务能力全部在各子服务内实现；
- 需要Node.js >= 18。
