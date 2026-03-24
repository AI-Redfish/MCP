

# file-必装

```
{
	"mcpServers": {
		// windows
	
		"files": {
			"command": "cmd",
			"args": [
				"/c",
				"npx",
				"-y",
				"@modelcontextprotocol/server-filesystem",  "C:/Users/redfish/Desktop"
			]
		}
	}
}
```





# Context7-必装

Context7 MCP 能直接从信息源提取最新的、特定版本的文档和代码示例，并将其整合到你的提示中。

案例：

```
Create a React 18 project with the new createRoot API. use context7
Create a basic Next.js project with app router. use context7
```

安装：

https://smithery.ai/servers/upstash/context7-mcp











# **microsoft/playwright-mcp-待深入研究**

浏览器自动化操作。

https://github.com/microsoft/playwright-mcp

```
#windows
"playwrightMCP": {
  "command": "cmd",
  "args": [
    "/c",
    "npx",
    "@playwright/mcp@latest"
  ]
}
```





# Puppeteer-待研究

相比playwright，Puppeteer：历史上更“贴近 CDP”，很多高级能力直接就是 CDP 的封装/调用。



**能用 CDP 做什么（常见能力）**

- 页面与 DOM：查 DOM、执行 JS、改样式、读写 localStorage/cookie
- 网络：监听/拦截请求、改请求头、抓响应内容、模拟离线/限速
- 性能与诊断：CPU profile、性能指标、console log、覆盖率
- 调试：断点、调用栈、source map、异常捕获
- 设备模拟：viewport、UA、触控、地理位置








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


# BrowserTools MCP

- 目标：让 AI（比如 Cursor 的 agent）能监控浏览器行为，抓取日志、网络请求、截图，辅助调试和交互。
- 开源地址：https://github.com/AgentDeskAI/browser-tools-mcp
- 开发者：Ted Werbel （@tedx_ai）
- 功能点：
  - 捕获浏览器日志：抓取 Chrome 的 console 日志（包括错误），喂给 LLM 分析。
  - 监控网络请求：提取 XHR 请求（成功和失败的），让 AI 查网络问题。
  - 截图支持：抓取网页截图，帮助 AI 理解页面状态。





## 使用步骤

1，下载仓库：https://github.com/AgentDeskAI/browser-tools-mcp

2，谷歌浏览器安装下载好的chrome-extension到谷歌浏览器。

3，启动node服务：npx @agentdeskai/browser-tools-server@latest

4，安装MCP：npx @agentdeskai/browser-tools-mcp@latest



如果使用失败，可以尝试关闭重启。
关闭浏览器，node服务，cursor(或其他agent)，按照如下步骤重启。

浏览器-》node服务-》cursor。



# Fetch MCP



## 使用步骤

- 抓网页：输入 URL，Fetch 去把内容弄回来
- 转格式：把乱七八糟的 HTML 转成干净的 Markdown（还能支持其他格式，比如纯文本）
- 喂 LLM：把抓来的内容通过 MCP 接口丢给智能体处理

Github: https://github.com/modelcontextprotocol/servers/blob/main/src/fetch/README.md



**使用**

```

windows
"fetch": {
      "command": "cmd",
      "args": [
        "/c",
        "uvx",
        "mcp-server-fetch"
      ]
    }
    
    
  
```



## 使用案例

**抓取网页并分析**

```
use MCP：fetch

获取: https://github.com/modelcontextprotocol/servers/ 
分析里面的内容。
```



# mysql

```
	windows环境
	
	"mysql": {
			  "command": "npx",
			  "args": [
				"-y",
				"@bytebase/dbhub",
				"--transport",
				"stdio",
				"--dsn",
				"mysql://root:root@localhost:3306/redfish",
				"--allow-insert",
				"--allow-update"
			  ],
			  "disabled": false,
			  "timeout": 60
			}
```



## 使用场景

1，使用MysqlMCP通过对话获取数据，并保存到file/db等地方，然后借助UI组件生成对应的图标。

实现基于对话灵活查询任意数据的图标。





# drawio

## 安装

**windows**

```

"drawio": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@next-ai-drawio/mcp-server@latest"
      ]
    }
```



**使用**

```
1，使用MCP： drawio
帮我创建一个sso流程图
```

