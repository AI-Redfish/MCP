# 概述

通过STDIO（进程内）和/或SSE（远程）传输协议同时连接到一个或多个MCP服务器。



其中SSE连接采用基于HttpClient的传输实现。每建立一个到MCP服务器的连接，即会创建一个新的MCP客户端实例。

开发者可选择使用同步（SYNC）或异步（ASYNC）模式的MCP客户端（注意：同一应用中不可混合使用同步与异步客户端）。

对于生产环境部署，建议采用基于SSE连接实现响应式流式处理。



# Maven依赖

```
<dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-model-ollama</artifactId>
        </dependency>


        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-starter-mcp-client</artifactId>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>

        <dependency>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId>
        </dependency>


        <dependency>
            <groupId>com.alibaba</groupId>
            <artifactId>fastjson</artifactId>
        </dependency>

</dependencies>

<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>org.springframework.ai</groupId>
            <artifactId>spring-ai-bom</artifactId>
            <version>${spring-ai.version}</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

```



# 配置文件

**properties**

```
server.port=8080
spring.graphql.graphiql.enabled=true


spring.ai.openai.api-key=sk-545c683f50bf4541a5f4c6ea9fe0f7f7
spring.ai.openai.base-url=https://api.deepseek.com
spring.ai.openai.chat.options.model=deepseek-chat


# MCP Client Configuration
spring.ai.mcp.client.enabled=true
spring.ai.mcp.client.toolcallback.enabled=true
spring.ai.mcp.client.name=mcp-client
spring.ai.mcp.client.version=1.0.0
spring.ai.mcp.client.type=ASYNC
spring.ai.mcp.client.request-timeout=30s

# 基于stdio的MCP服务端通过标准输入输出流与客户端通信，适用于作为子进程被客户端启动和管理的场景，非常适合嵌入式应用。
spring.ai.mcp.client.stdio.servers-configuration=classpath:/mcp-server-config.json
```

**mcp-servers-config.json**

```
linux：

{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "."
      ]
    }
  }
}

windows：
{
  "mcpServers": {
    "filesystem": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\redfish\\Desktop"
      ]
    }
  }
}

```







# 代码

## 关键类

**公共client**

```
    @Bean("deepSeekChatClient")
    public ChatClient deepSeekChatClient(OpenAiChatModel openAiChatModel, ToolCallbackProvider toolCallbackProvider) {
        ChatClient chatClient = ChatClient.builder(openAiChatModel)
                .defaultToolCallbacks(toolCallbackProvider.getToolCallbacks())
                .build();
        return chatClient;
    }
```



```
import jakarta.annotation.Resource;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.mcp.SyncMcpToolCallbackProvider;
import org.springframework.ai.ollama.OllamaChatModel;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }


    @RestController
    public static class ChatController {
        @Resource
        private OllamaChatModel ollamaChatModel;

        @Resource
        private SyncMcpToolCallbackProvider toolCallbackProvider;
        
        
          @PostMapping("/mcp/client/chat")
            public String call(@RequestBody JSONObject reqBody) {
                String input = reqBody.getString("input");
                return chatClient.prompt(input).call().content();
            }
            }
}
```



## npx执行报错

npx部署本地mcp-server可能存在各种问题，按照如下步骤进行操作。

**清理npm本地缓存**

```
npm cache clean --force
```

或者手动删除缓存文件夹。

```
windows：C:\Users\redfish\AppData\Local\npm-cache
```





# 测试用例

```localhost:8080/chat?input=帮我创建一个文件夹 mcp
// 简单创建
http://localhost:8080/chat?input=帮我在文件夹mcp下创建一个 test.txt 文件，并写入 hello mcp！
http://localhost:8080/chat?input=帮我将 mcp/test.txt 中 hello mcp 改为 Hello MCP！

// 创建并写入相关内容，自动写代码。
http://localhost:8080/chat?input=帮我创建一个redfish.txt，并写入测试类，测试www.baidu.com是否能正常访问
```



























