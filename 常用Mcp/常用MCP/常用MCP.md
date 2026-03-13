# **microsoft/playwright-mcp**

浏览器自动化操作。

https://smithery.ai/servers/microsoft/playwright-mcp

```
"playwright-mcp": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@smithery/cli@latest",
        "run",
        "microsoft/playwright-mcp"
      ]
    }
  }
```



# Chrome Developer Tools

## **对别Playwright**

核心区别一句话：

- Playwright MCP：偏“自动化执行”（像测试机器人）。
- Chrome DevTools MCP：偏“调试诊断”（像开发者工具远程大脑）。

对比优劣（MCP 场景）：

- **跨浏览器**：Playwright 强（Chromium/Firefox/WebKit）；DevTools 基本是 Chrome/Chromium。
- **自动化稳定性**：Playwright 更强（自动等待、选择器、上下文隔离、适合回归）。
- **调试深度**：DevTools 更强（Network/Console/Performance/Memory/Protocol 级信息）。
- **CI/CD 友好度**：Playwright 更强（无头、并行、测试体系成熟）。
- **排查前端疑难问题**（卡顿、泄漏、请求链路）：DevTools 更直接。
- **上手目标**：要“批量跑流程”选 Playwright；要“定位问题根因”选 DevTools。

选型建议：

1. 你要做 E2E 测试、回归、批量操作网页：选 Playwright MCP（推荐）。
2. 你要做性能/内存/网络/控制台深度排查：选 Chrome DevTools MCP（推荐）。
3. 团队最佳实践：**两者都用**——Playwright 负责复现和回归，DevTools 负责根因分析。







# Context7

Context7 MCP 能直接从信息源提取最新的、特定版本的文档和代码示例，并将其整合到你的提示中。

案例：

```
Create a React 18 project with the new createRoot API. use context7
Create a basic Next.js project with app router. use context7
```

安装：

https://smithery.ai/servers/upstash/context7-mcp
