# windows环境

```
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

