import type {
  BrowserConnector, BrowserPort, ContextPort, DialogPort, DownloadPort, LocatorPort, PagePort,
} from '../src/ports.js';
import type { LocatorSpec } from '../src/types.js';

/** 离线假件：不启动浏览器、不联网（P1 退出门槛：多数单测无浏览器/无 key）。 */

export class FakeLocator implements LocatorPort {
  calls: string[] = [];
  constructor(
    private readonly state: { count: number; text: string; visible: boolean; clickError?: Error; fillError?: Error },
  ) {}

  async count(): Promise<number> {
    this.calls.push('count');
    return this.state.count;
  }

  first(): LocatorPort {
    return this;
  }

  async click(): Promise<void> {
    this.calls.push('click');
    if (this.state.clickError) throw this.state.clickError;
  }

  async fill(value: string): Promise<void> {
    this.calls.push(`fill:${value}`);
    if (this.state.fillError) throw this.state.fillError;
  }

  async press(key: string): Promise<void> {
    this.calls.push(`press:${key}`);
  }

  async selectOption(value: string): Promise<void> {
    this.calls.push(`select:${value}`);
  }

  async isVisible(): Promise<boolean> {
    return this.state.visible;
  }

  async innerText(): Promise<string> {
    this.calls.push('innerText');
    return this.state.text;
  }

  async waitFor(): Promise<void> {
    this.calls.push('waitFor');
    if (!this.state.visible) throw new Error('timeout: element not visible');
  }
}

export interface FakePageOptions {
  url?: string;
  title?: string;
  bodyText?: string;
  elements?: Array<{ role: string; name: string }>;
  clickError?: Error;
  downloadAfterClick?: { filename: string; content: string };
}

export class FakePage implements PagePort {
  currentUrl: string;
  calls: Array<string> = [];
  /** 每次动作后可选切换的 URL（模拟导航）。 */
  urlAfterNavigate?: string;
  downloads: Array<{ filename: string; content: string }> = [];
  isClosedFlag = false;

  constructor(private readonly opts: FakePageOptions = {}) {
    this.currentUrl = opts.url ?? 'https://example.com/';
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.opts.title ?? 'Example';
  }

  async goto(url: string): Promise<unknown> {
    this.calls.push(`goto:${url}`);
    this.currentUrl = this.urlAfterNavigate ?? url;
    return {};
  }

  locator(spec: LocatorSpec): LocatorPort {
    this.calls.push(`locator:${JSON.stringify(spec)}`);
    return new FakeLocator({
      count: this.opts.elements?.length ?? 1,
      text: this.opts.bodyText ?? 'Example',
      visible: true,
      clickError: this.opts.clickError,
    });
  }

  async evaluate(script: string): Promise<unknown> {
    this.calls.push('evaluate');
    if (script.includes('readyState')) return true;
    if (script.includes('.includes(')) {
      const m = script.match(/includes\((".*?")\)/);
      const needle = m ? JSON.parse(m[1]) as string : '';
      return (this.opts.bodyText ?? '').includes(needle);
    }
    if (script.includes('querySelectorAll')) {
      return {
        elements: (this.opts.elements ?? []).map((e, i) => ({ i, role: e.role, name: e.name, tag: 'button', text: e.name })),
        truncated: false,
      };
    }
    return null;
  }

  async keyboardPress(key: string): Promise<void> {
    this.calls.push(`key:${key}`);
  }

  async mouseWheel(_dx: number, dy: number): Promise<void> {
    this.calls.push(`wheel:${dy}`);
  }

  async screenshot(opts?: { path?: string }): Promise<Buffer> {
    this.calls.push('screenshot');
    const buf = Buffer.from('png-bytes');
    if (opts?.path) (require('node:fs') as typeof import('node:fs')).writeFileSync(opts.path, buf);
    return buf;
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.calls.push(`wait:${ms}`);
  }

  async waitForDownload(): Promise<DownloadPort> {
    this.calls.push('waitForDownload');
    const dl = this.opts.downloadAfterClick;
    return {
      async saveAs(path: string): Promise<void> {
        (require('node:fs') as typeof import('node:fs')).writeFileSync(path, dl?.content ?? 'data');
      },
      async failure(): Promise<string | null> {
        return null;
      },
      suggestedFilename(): string {
        return dl?.filename ?? 'download.bin';
      },
    };
  }

  onDialog(handler: (d: DialogPort) => void): void {
    this.calls.push('onDialog');
    void handler;
  }

  markClosed(): void {
    this.isClosedFlag = true;
  }
}

export class FakeContext implements ContextPort {
  constructor(public readonly pagesList: FakePage[]) {}

  pages(): PagePort[] {
    return this.pagesList.filter((p) => !p.isClosedFlag);
  }

  async newPage(url?: string): Promise<PagePort> {
    const p = new FakePage({ url: url ?? 'about:blank' });
    this.pagesList.push(p);
    return p;
  }

  onPage(_handler: (page: PagePort) => void): void {
    /* 测试不需要 */
  }
}

export class FakeBrowser implements BrowserPort {
  closed = false;
  constructor(public readonly context: FakeContext) {}

  contexts(): ContextPort[] {
    return [this.context];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeConnector implements BrowserConnector {
  lastConnect = 0;
  constructor(private readonly browser: FakeBrowser) {}

  async connect(): Promise<{ browser: BrowserPort; ownership: 'borrowed' | 'owned'; kind: 'attach' }> {
    this.lastConnect += 1;
    return { browser: this.browser, ownership: 'borrowed', kind: 'attach' };
  }
}
