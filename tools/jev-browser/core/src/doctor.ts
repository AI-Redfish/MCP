import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, credentialPresent, redactForDoctor, type LoadConfigOptions } from './config.js';
import { err } from './errors.js';
import { PlaywrightConnector } from './connectors.js';

/**
 * doctor（DESIGN §5.1 / P1）：区分“只检查配置”与“经用户同意尝试连接”。
 * 不自行变更 Chrome 设置；绝不打印 secret 值。
 */

export interface DoctorResult {
  config: {
    file?: string;
    envKeys: string[];
    effective: Record<string, unknown>;
  };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  credentials: { jev: boolean; planner: boolean; api: boolean };
  connect?: {
    attempted: boolean;
    ok: boolean;
    detail: string;
    pages?: Array<{ title: string; url: string }>;
  };
}

export async function runDoctor(opts: LoadConfigOptions & { attemptConnect?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<DoctorResult> {
  const env = opts.env ?? process.env;
  const { config, sources } = loadConfig({ file: opts.file, env, overrides: opts.overrides });
  const checks: DoctorResult['checks'] = [];

  // Node 版本（node:sqlite 需要 ≥ 24，DESIGN §9.1）
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 24, detail: `node ${process.versions.node}（本工具需要 ≥ 24：node:sqlite）` });

  // 数据目录
  try {
    fs.mkdirSync(config.runtime.dataDir, { recursive: true });
    checks.push({ name: 'dataDir', ok: true, detail: config.runtime.dataDir });
  } catch (e) {
    checks.push({ name: 'dataDir', ok: false, detail: `${config.runtime.dataDir}: ${(e as Error).message}` });
  }

  // launch profile 目录占用（粗查 Singlock 文件）
  if (config.browser.mode === 'launch') {
    const udd = config.browser.launch.userDataDir ?? path.join(config.runtime.dataDir, 'profiles', config.browser.engine, 'default');
    const lockFile = path.join(udd, 'Singlock');
    checks.push({ name: 'launchProfile', ok: !fs.existsSync(lockFile), detail: fs.existsSync(lockFile) ? `${udd} 似乎被占用（Singlock 存在）` : udd });
    if (config.browser.engine === 'chromium') {
      checks.push({ name: 'chromiumInstall', ok: true, detail: '未自动检查；显式执行 npx playwright install chromium（方案：浏览器下载是显式 setup）' });
    }
  }

  const credentials = {
    jev: credentialPresent(config, 'jev', env),
    planner: credentialPresent(config, 'planner', env),
    api: credentialPresent(config, 'api', env),
  };
  checks.push({
    name: 'credentials',
    ok: true,
    detail: `jev(${config.jev.apiKeyEnv})=${credentials.jev ? '已配置' : '未配置（纯确定性 execute 不需要）'}; planner=${credentials.planner ? '已配置' : '未配置（run 需要）'}; api token=${credentials.api ? '已配置' : '未配置（启动 API 需要）'}`,
  });

  const result: DoctorResult = {
    config: { file: sources.file, envKeys: sources.envKeys, effective: redactForDoctor(config) },
    checks,
    credentials,
  };

  if (opts.attemptConnect && config.browser.mode === 'attach') {
    try {
      const connector = new PlaywrightConnector(config);
      const res = await connector.connect();
      const context = res.browser.contexts()[0];
      const pages = context ? context.pages() : [];
      const pageMeta = [] as Array<{ title: string; url: string }>;
      for (let i = 0; i < Math.min(pages.length, 10); i++) {
        let title = '';
        try {
          title = await pages[i].title();
        } catch {
          title = '';
        }
        let u = pages[i].url();
        try {
          const uu = new URL(u);
          u = `${uu.protocol}//${uu.host}${uu.pathname}`;
        } catch {
          /* keep */
        }
        pageMeta.push({ title: title.slice(0, 60), url: u.slice(0, 120) });
      }
      await res.browser.close().catch(() => undefined);
      result.connect = { attempted: true, ok: true, detail: `接管成功（${res.ownership}），页面数 ${pages.length}`, pages: pageMeta };
      checks.push({ name: 'connect', ok: true, detail: result.connect.detail });
    } catch (e) {
      result.connect = { attempted: true, ok: false, detail: (e as Error).message.slice(0, 300) };
      checks.push({ name: 'connect', ok: false, detail: result.connect.detail });
    }
  } else if (opts.attemptConnect) {
    result.connect = { attempted: false, ok: false, detail: '当前 mode 不是 attach；connect 检查只适用于接管模式' };
  }

  void err;
  return result;
}
