import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import type { JevBrowserConfig } from './config.js';
import { err } from './errors.js';
import type { BrowserConnector, BrowserPort, ConnectResult, ContextPort, DialogPort, PagePort } from './ports.js';

/**
 * Playwright 连接器（DESIGN §4）：attach 借用日常 Chrome，launch 拥有独立实例。
 * 边界处用 cast 接入端口接口；生命周期约束：
 *  - attach: 绝不 newContext / 绝不 close 借用 context；browser.close() 仅断开 CDP 连接
 *    （Playwright 语义：清理“本连接创建的” context 并断开；P0 需端到端复核，DESIGN §4.3 [S5]）。
 *  - launch: 每个 engine 使用独立 profile 目录；实例可由工具关闭。
 */

export class PlaywrightConnector implements BrowserConnector {
  constructor(private readonly cfg: JevBrowserConfig) {}

  async connect(): Promise<ConnectResult> {
    const b = this.cfg.browser;
    if (b.mode === 'attach') {
      // endpoint 'chrome' 走 channel 发现（DevToolsActivePort），显式 URL 直接连接（DESIGN §4.1）
      const endpoint = b.attach.endpoint;
      try {
        const browser = await chromium.connectOverCDP(endpoint, {
          noDefaults: b.attach.noDefaults,
          timeout: b.attach.timeoutMs,
        });
        return { browser: browser as unknown as BrowserPort, ownership: 'borrowed', kind: 'attach' };
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0].slice(0, 200);
        throw err('BROWSER_BUSY', `接管 Chrome 失败（需在 chrome://inspect/#remote-debugging 开启授权，Chrome ≥ 144）：${msg}`, {
          details: { endpoint },
        });
      }
    }
    // launch：本机 Chrome（channel）或 Playwright 管理的 Chromium；独立 profile 目录
    const userDataDir = b.launch.userDataDir ?? path.join(this.cfg.runtime.dataDir, 'profiles', b.engine, 'default');
    fs.mkdirSync(userDataDir, { recursive: true });
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: b.headless,
        chromiumSandbox: b.launch.chromiumSandbox,
        timeout: b.launch.timeoutMs,
        channel: b.engine === 'chrome' ? 'chrome' : undefined,
      });
      const context = ctx as unknown as ContextPort;
      const wrapper: BrowserPort = {
        contexts: () => [context],
        close: () => ctx.close(),
      };
      return { browser: wrapper, ownership: 'owned', kind: 'launch' };
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0].slice(0, 200);
      if (/Executable doesn't exist/i.test(msg)) {
        throw err('CAPABILITY_UNSUPPORTED', 'Playwright 管理的 Chromium 未安装。显式执行: npx playwright install chromium');
      }
      throw err('BROWSER_BUSY', `启动浏览器失败: ${msg}`);
    }
  }
}

/** 会话页面选择（DESIGN §4.1/§8.1）：单页自动选定；多页不猜，返回候选。 */
export interface PageSelection {
  page: PagePort | null;
  candidates: Array<{ pageId: string; title: string; url: string }>;
}

export async function selectPage(context: ContextPort, pageId?: string): Promise<PageSelection> {
  const pages = context.pages().filter((p) => !isClosedSafe(p));
  const candidates = [] as PageSelection['candidates'];
  for (let i = 0; i < pages.length; i++) {
    let title = '';
    try {
      title = await pages[i].title();
    } catch {
      title = '';
    }
    candidates.push({ pageId: `p${i}`, title: title.slice(0, 80), url: redact(pages[i].url()) });
  }
  if (pageId !== undefined) {
    const idx = Number(pageId.replace(/^p/, ''));
    if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
      throw err('PAGE_NOT_RESOLVED', `pageId 不存在: ${pageId}`, { details: { candidates } });
    }
    return { page: pages[idx], candidates };
  }
  if (pages.length === 1) return { page: pages[0], candidates };
  return { page: null, candidates };
}

function isClosedSafe(p: PagePort): boolean {
  try {
    return (p as unknown as { isClosed(): boolean }).isClosed();
  } catch {
    return false;
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparsable)';
  }
}

/**
 * Dialog 控制器（DESIGN §4.4）：
 *  - 已接管页安装 handler 后由本工具决策（默认保守 dismiss 并记录）；
 *  - 未接管页不安装 handler——行为由 Playwright/CDP 决定，P0 验证项，不在代码里承诺。
 */
export class DialogManager {
  private policies = new WeakMap<object, { accept: boolean; reason: string }>();
  private installed = new WeakSet<object>();

  install(page: PagePort, onEvent?: (info: { type: string; message: string; accepted: boolean }) => void): void {
    const key = page as unknown as object;
    if (this.installed.has(key)) return;
    this.installed.add(key);
    page.onDialog(async (dialog: DialogPort) => {
      const policy = this.policies.get(key) ?? { accept: false, reason: '默认保守拒绝（未授权的对话框不自动接受）' };
      let accepted = false;
      try {
        if (policy.accept) {
          await dialog.accept();
          accepted = true;
        } else {
          await dialog.dismiss();
        }
      } catch {
        // 对话框可能已被页面导航取消
      }
      onEvent?.({ type: dialog.type(), message: dialog.message().slice(0, 120), accepted });
      if (policy.accept) this.policies.delete(key); // 一次性授权
    });
  }

  /** 动作前武装：已授权的预期 confirm 才允许接受（DESIGN §4.4）。 */
  armOnce(page: PagePort, reason: string): void {
    this.install(page);
    this.policies.set(page as unknown as object, { accept: true, reason });
  }
}
