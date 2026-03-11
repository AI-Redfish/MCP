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









# Context7

Context7 MCP 能直接从信息源提取最新的、特定版本的文档和代码示例，并将其整合到你的提示中。

案例：

```
Create a React 18 project with the new createRoot API. use context7
Create a basic Next.js project with app router. use context7
```

安装：

https://smithery.ai/servers/upstash/context7-mcp



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



# file

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

