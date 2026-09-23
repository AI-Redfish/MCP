#!/usr/bin/env node
/**
 * MCP 集合启动器（Launcher）
 *
 * 仓库根目录的入口只做一件事：
 *   1. 解析命令行参数中的子服务名（如 server-a）
 *   2. 定位 mcps/<子服务名>/ 目录
 *   3. 如有必要：安装依赖（pnpm/npm workspace）并构建（tsc -b）
 *   4. 以子进程方式启动该服务的 MCP 入口，并透传 stdio / 信号 / 退出码
 *
 * 每个子服务是一个 core + cli + mcp 三包工作区（核心逻辑与适配层分离）：
 * 启动器只关心 MCP 入口 mcp/dist/index.js（旧版单文件 index.js 仍兼容）。
 *
 * 用法：
 *   mcp-collection <server-name> [extra args...]   启动某个子服务（MCP 方式）
 *   mcp-collection list                            列出所有可用子服务
 *   mcp-collection build <server-name>             安装依赖并构建某个子服务
 *   mcp-collection help                            显示帮助
 *
 * 注意：stdout 是 MCP stdio 协议通道，启动器自身与安装/构建的一切日志都输出到 stderr！
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MCPS_ROOT = path.join(__dirname, '..', 'mcps');
const IS_WIN = process.platform === 'win32';

const exists = (p) => fs.existsSync(p);

/** 选择包管理器：优先 pnpm（原生 workspace 支持），否则回退 npm */
function pickRunner() {
  const res = spawnSync('pnpm', ['-v'], { stdio: 'ignore', shell: IS_WIN });
  return res.status === 0 ? 'pnpm' : 'npm';
}

/** 子服务是否为 workspace（含 pnpm-workspace.yaml 或 workspace 根 package.json） */
function isWorkspace(serverDir) {
  return exists(path.join(serverDir, 'pnpm-workspace.yaml')) || exists(path.join(serverDir, 'package.json'));
}

/**
 * 定位子服务的 MCP 入口：
 *   - 新版 workspace 布局：mcp/dist/index.js（TypeScript 构建产物）
 *   - 旧版单文件布局：index.js
 */
function resolveEntry(serverDir) {
  const workspaceEntry = path.join(serverDir, 'mcp', 'dist', 'index.js');
  if (exists(workspaceEntry)) return { entry: workspaceEntry, workspace: true };
  const legacyEntry = path.join(serverDir, 'index.js');
  if (exists(legacyEntry)) return { entry: legacyEntry, workspace: false };
  return null;
}

function readPkgField(serverDir, field) {
  const pkgPath = path.join(serverDir, 'package.json');
  if (!exists(pkgPath)) return '';
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'))[field] || '';
  } catch (_) {
    return '';
  }
}

/** 扫描 mcps/ 下所有可用子服务（新版 workspace 或旧版单文件均可） */
function listServers() {
  if (!exists(MCPS_ROOT)) return [];
  return fs
    .readdirSync(MCPS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => {
      const dir = path.join(MCPS_ROOT, d.name);
      return isWorkspace(dir) || exists(path.join(dir, 'index.js'));
    })
    .map((d) => d.name)
    .sort();
}

function printServers() {
  const servers = listServers();
  if (servers.length === 0) {
    console.error('mcps/ 目录下暂无可用服务。');
    return;
  }
  console.error(`可用的 MCP 子服务（位于 ${MCPS_ROOT}）：`);
  for (const name of servers) {
    const desc = readPkgField(path.join(MCPS_ROOT, name), 'description');
    console.error(`  - ${name}${desc ? '  ' + desc : ''}`);
  }
}

function printHelp() {
  console.error(`MCP 集合启动器

每个子服务是一个 core + cli + mcp 三包工作区：core 存放核心逻辑（纯函数/类），
mcp 与 cli 是两种对外适配器，共享同一份实现 —— 一个工具，多种提供方式。

用法：
  npx github:<用户名>/<仓库名> <server-name> [extra args...]

命令：
  list                    列出 mcps/ 目录下所有可用的子服务
  build <server-name>     安装依赖并构建某个子服务（开发调试用）
  help, -h, --help        显示本帮助

说明：
  <server-name> 对应 mcps/<server-name>/ 子目录。
  首次启动时，启动器会自动安装依赖（优先 pnpm，回退 npm）并执行 tsc 构建，
  然后拉起 MCP 入口 mcp/dist/index.js（兼容旧版单文件 index.js）。
  也可以用 CLI 适配器直接调用同一批工具：
    node mcps/<server-name>/cli/dist/index.js --help`);
}

/**
 * 确保 workspace 子服务就绪：按需安装依赖、按需构建。
 * 所有安装/构建输出重定向到本进程的 stderr，避免污染 stdout（MCP 协议通道）。
 */
function ensureReady(serverDir, serverName, { forceBuild = false } = {}) {
  if (!isWorkspace(serverDir)) return true; // 旧版单文件服务，无需处理

  const distEntry = path.join(serverDir, 'mcp', 'dist', 'index.js');
  const needInstall = !exists(path.join(serverDir, 'node_modules'));
  const needBuild = forceBuild || !exists(distEntry);
  if (!needInstall && !needBuild) return true;

  const runner = pickRunner();
  const runInDir = (args) => {
    const res = spawnSync(runner, args, {
      cwd: serverDir,
      stdio: ['ignore', process.stderr.fd, process.stderr.fd],
      shell: IS_WIN,
    });
    return res.status;
  };

  if (needInstall) {
    console.error(`[launcher] 使用 ${runner} 安装 "${serverName}" 的依赖...`);
    const code = runInDir(runner === 'pnpm' ? ['install'] : ['install', '--no-audit', '--no-fund']);
    if (code !== 0) {
      console.error(`[launcher] "${serverName}" 依赖安装失败，退出。`);
      return false;
    }
  }

  if (needBuild) {
    console.error(`[launcher] 正在构建 "${serverName}"（tsc -b）...`);
    const code = runInDir(['run', 'build']);
    if (code !== 0) {
      console.error(`[launcher] "${serverName}" 构建失败，退出。`);
      return false;
    }
  }
  return true;
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

// ---------- 构建（开发调试用） ----------
if (serverName === 'build') {
  const target = restArgs[0];
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) {
    console.error('[launcher] 用法：build <server-name>');
    process.exit(1);
  }
  const dir = path.join(MCPS_ROOT, target);
  if (!exists(dir)) {
    console.error(`[launcher] 未找到子服务 "${target}"。`);
    printServers();
    process.exit(1);
  }
  const ok = ensureReady(dir, target, { forceBuild: true });
  if (ok) console.error(`[launcher] "${target}" 已就绪。`);
  process.exit(ok ? 0 : 1);
}

if (!exists(serverDir)) {
  console.error(`[launcher] 未找到子服务 "${serverName}"（期望存在 ${serverDir}）。`);
  printServers();
  process.exit(1);
}

// ---------- 按需安装依赖并构建 ----------
if (!ensureReady(serverDir, serverName)) {
  process.exit(1);
}

// ---------- 定位入口 ----------
const resolved = resolveEntry(serverDir);
if (!resolved) {
  console.error(`[launcher] 子服务 "${serverName}" 缺少可执行入口：`);
  console.error(`  - ${path.join(serverDir, 'mcp', 'dist', 'index.js')}（workspace 布局，需先构建）`);
  console.error(`  - ${path.join(serverDir, 'index.js')}（旧版单文件布局）`);
  console.error(`可尝试运行：npx github:AI-Redfish/MCP build ${serverName}`);
  process.exit(1);
}

// ---------- 启动子进程 ----------
console.error(`[launcher] 启动 MCP 子服务 "${serverName}" ...`);
const child = spawn(process.execPath, [resolved.entry, ...restArgs], {
  cwd: path.dirname(resolved.entry),
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
