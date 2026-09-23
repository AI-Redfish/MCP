#!/usr/bin/env node
/**
 * MCP 集合启动器（Launcher）
 *
 * 仓库根目录的入口只做一件事：
 *   1. 解析命令行参数中的子服务名（如 server-a）
 *   2. 定位 mcps/<子服务名>/ 目录
 *   3. 如有必要，安装该子服务声明的依赖
 *   4. 以子进程方式启动该服务，并透传 stdio / 信号 / 退出码
 *
 * 用法：
 *   mcp-collection <server-name> [extra args...]
 *   mcp-collection list     列出所有可用子服务
 *   mcp-collection help     显示帮助
 *
 * 注意：stdout 是 MCP stdio 协议通道，启动器自身的一切日志都输出到 stderr！
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MCPS_ROOT = path.join(__dirname, '..', 'mcps');

/** 扫描 mcps/ 下所有包含 index.js 的子目录，即可用的子服务 */
function listServers() {
  if (!fs.existsSync(MCPS_ROOT)) return [];
  return fs
    .readdirSync(MCPS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(MCPS_ROOT, d.name, 'index.js')))
    .map((d) => d.name)
    .sort();
}

function printServers() {
  const servers = listServers();
  if (servers.length === 0) {
    console.error('mcps/ 目录下暂无可用服务（缺少含 index.js 的子目录）。');
    return;
  }
  console.error(`可用的 MCP 子服务（位于 ${MCPS_ROOT}）：`);
  for (const name of servers) {
    const pkgPath = path.join(MCPS_ROOT, name, 'package.json');
    let desc = '';
    if (fs.existsSync(pkgPath)) {
      try {
        desc = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).description || '';
      } catch (_) {
        /* 忽略损坏的 package.json */
      }
    }
    console.error(`  - ${name}${desc ? '  ' + desc : ''}`);
  }
}

function printHelp() {
  console.error(`MCP 集合启动器

用法：
  npx github:<用户名>/<仓库名> <server-name> [extra args...]

命令：
  list              列出 mcps/ 目录下所有可用的子服务
  help, -h, --help  显示本帮助

说明：
  <server-name> 对应 mcps/<server-name>/ 子目录（入口为其中的 index.js）。
  子服务如声明了自身依赖（package.json 的 dependencies），首次启动时会自动 npm install。`);
}

const [, , serverName, ...restArgs] = process.argv;

// ---------- 无参数 / 帮助 ----------
if (!serverName || ['-h', '--help', 'help'].includes(serverName)) {
  printHelp();
  printServers();
  process.exit(0);
}

// ---------- 列出服务 ----------
if (['-l', '--list', 'list'].includes(serverName)) {
  printServers();
  process.exit(0);
}

// ---------- 校验服务名（防止路径穿越） ----------
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(serverName)) {
  console.error(`[launcher] 非法的服务名："${serverName}"（只允许字母、数字、"."、"_"、"-"）。`);
  process.exit(1);
}

const serverDir = path.join(MCPS_ROOT, serverName);
const entry = path.join(serverDir, 'index.js');

if (!fs.existsSync(entry)) {
  console.error(`[launcher] 未找到子服务 "${serverName}"（期望存在 ${entry}）。`);
  printServers();
  process.exit(1);
}

// ---------- 按需安装子服务自身依赖 ----------
const pkgPath = path.join(serverDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.error(`[launcher] 解析 ${pkgPath} 失败：${err.message}`);
    process.exit(1);
  }
  const hasDeps = pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
  const hasInstalled = fs.existsSync(path.join(serverDir, 'node_modules'));
  if (hasDeps && !hasInstalled) {
    console.error(`[launcher] 首次启动 "${serverName}"，正在安装其依赖...`);
    // shell:true 兼容 Windows 下 npm.cmd
    const res = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: serverDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true,
    });
    if (res.status !== 0) {
      console.error(`[launcher] "${serverName}" 依赖安装失败，退出。`);
      process.exit(res.status === null ? 1 : res.status);
    }
  }
}

// ---------- 启动子进程 ----------
console.error(`[launcher] 启动 MCP 子服务 "${serverName}" ...`);
const child = spawn(process.execPath, [entry, ...restArgs], {
  cwd: serverDir,
  stdio: 'inherit', // stdin/stdout/stderr 全部透传，stdout 即 MCP stdio 协议通道
  env: { ...process.env, MCP_SERVER_NAME: serverName },
});

child.on('error', (err) => {
  console.error(`[launcher] 启动子进程失败：${err.message}`);
  process.exit(1);
});

// 转发终止信号，保证客户端断开时子服务一起退出
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch (_) {
      /* 子进程可能已退出 */
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch (_) {
      process.exit(1);
    }
  } else {
    process.exit(code === null ? 1 : code);
  }
});
