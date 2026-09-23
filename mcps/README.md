# mcps/ —— MCP 子服务目录

本目录存放各个 MCP 服务的代码，每个子目录就是一个子服务：

```
mcps/
└── server-a/          # 子服务名（即启动器参数）
    ├── index.js       # 入口（必需）
    └── package.json   # 元数据（可选；若声明 dependencies，首次启动时启动器会自动安装）
```

## 启动方式

由仓库根目录的启动器统一拉起：

```bash
npx github:<用户名>/<仓库名> server-a
```

## 新增一个子服务

1. 在 `mcps/` 下新建子目录，目录名即服务名（只允许字母、数字、`.`、`_`、`-`）；
2. 在其中创建 `index.js` 作为入口，实现一个标准 stdio MCP Server；
3. （可选）创建 `package.json`：
   - 纯元数据（无 `dependencies`）：直接运行，依赖会沿目录向上解析（可用根目录已安装的包）；
   - 声明了自己的 `dependencies`：首次启动时启动器会自动 `npm install`；
4. 运行 `node bin/mcp-launcher.js list` 确认已被识别。

## 注意事项

- stdio 传输下 **stdout 是 MCP 协议通道**，服务自身的日志务必用 `console.error`（stderr）输出；
- 子服务通过环境变量 `MCP_SERVER_NAME` 可获知自己的服务名。
