



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









# Sequential Thinking + Software Planning Tool

这两个 MCP 常用来解决“复杂问题不好下手”的情况：一个帮你**按步骤推演**，一个帮你**把需求拆成可执行的研发计划**。



## **Sequential Thinking**

**战略家/架构师**。负责分析需求、评估风险、制定策略、在遇到错误时回退并重新规划。它不直接写代码，而是生成“行动计划”。

如同资深技术主管 (Tech Lead)。



**安装**


```
// Windows
    "sequential-thinking": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ]
    }
```



## **Software Planning Tool**

**项目经理/看板**。负责将战略家的计划转化为具体的 Task 列表，追踪每个任务的状态 (Todo/Doing/Done)，记录依赖关系，防止任务遗漏。

项目经理 (PM) + Jira/Trello



**安装**


```
git clone https://github.com/NightTrek/Software-planning-mcp.git
cd Software-planning-mcp
npm install
npm run build

// Windows
"software-planning": {
  "command": "cmd",
  "args": [
    "/c",
    "node",
    "D:/develop/Agent/mcp/Software-planning-mcp/build/index.js"
  ],
  "disabled": false,
  "env": {}
}
```



## 工作流程

1. **输入**：用户提出复杂需求（如“开发一个带支付功能的电商后台”）。
2. 思考 (Sequential Thinking)
   - AI 调用 `sequential_thinking` 工具。
   - 分解问题：数据库设计 -> API 定义 -> 前端页面 -> 支付集成 -> 测试。
   - **动态反思**：AI 思考：“直接做支付可能太复杂，是否需要先模拟支付接口？”，“数据库选型用 MySQL 还是 Mongo？根据需求看关系型更合适。”
   - 输出：一份经过深思熟虑的**高阶路线图 (Roadmap)**。
3. 规划 (Planning Tool)
   - AI 调用 `create_plan` 或 `add_tasks`。
   - 将路线图转化为具体的、可执行的 Task 列表（例如：`Task-001: 设计 User 表`, `Task-002: 实现登录 API`）。
   - 设定依赖：`Task-002` 依赖 `Task-001`。
4. 执行 (Coding Agent)
   - AI 读取 Planning Tool 中的第一个 "Todo" 任务。
   - 编写代码、运行测试。
5. 反馈与更新
   - 如果测试失败，AI 再次触发 **Sequential Thinking** 分析错误原因。
   - 思考后，调用 Planning Tool **更新任务状态**（标记为 Failed，或插入新的 Debug 任务）。
   - 如果任务完成，标记为 Done，自动进入下一个任务。



**案例**

```
我要做一个‘个人记账 Web 应用’。前端用 React + Tailwind，后端用 Node.js + Express，数据库用 SQLite。需要支持分类、日期筛选和简单的图表展示。请帮我规划并生成代码。
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



## 使用场景

1，使用MysqlMCP通过对话获取数据，并保存到file/db等地方，然后借助UI组件生成对应的图标。

实现基于对话灵活查询任意数据的图标。



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

