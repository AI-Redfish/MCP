

# Maven依赖

```
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-mcp-client-spring-boot-starter</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-ollama-spring-boot-starter</artifactId>
    </dependency>

    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-test</artifactId>
        <scope>test</scope>
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
spring.ai.ollama.base-url=http://localhost:11434
spring.ai.ollama.chat.model=qwen2.5:latest

# MCP Client Configuration
spring.ai.mcp.client.enabled=true
spring.ai.mcp.client.toolcallback.enabled=true
spring.ai.mcp.client.name=mcp-client
spring.ai.mcp.client.version=1.0.0
spring.ai.mcp.client.type=SYNC
spring.ai.mcp.client.request-timeout=30s
spring.ai.mcp.client.stdio.servers-configuration=classpath:/mcp-servers-config.json

debug=true
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
        "D:\\",
        "C:\\Users\\redfish\\Desktop"
      ]
    }
  }
}
```





# 启动类

## 代码

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

        @GetMapping("/chat")
        public String call(@RequestParam(name = "input") String input) {
            ChatClient chatClient = ChatClient.builder(ollamaChatModel)
                    .defaultToolCallbacks(toolCallbackProvider.getToolCallbacks())
                    .build();
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
http://localhost:8080/chat?input=帮我创建一个文件夹 mcp
http://localhost:8080/chat?input=帮我在文件夹mcp下创建一个 test.txt 文件，并写入 hello mcp！
http://localhost:8080/chat?input=帮我将 mcp/test.txt 中 hello mcp 改为 Hello MCP！
```

