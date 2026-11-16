import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, isIP } from 'node:net';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, ProxyAgent } from 'undici';
import { parse, stringify } from 'yaml';
import { AppError } from './core';
import { readLimited, type HttpClient } from './http';

const SUBSCRIPTION_KEY = 'chatgptSub.mihomo.subscription';
const ENABLED_KEY = 'chatgptSub.mihomo.enabled';
const SELECTED_KEY = 'chatgptSub.mihomo.selected';
const MAX_SUBSCRIPTION = 4 * 1024 * 1024;
type SubscriptionResult = { count: number; directFallback: boolean };

export async function withSubscriptionFallback<T>(enabled: boolean, allowFallback: boolean, attempt: (proxy: boolean) => Promise<T>): Promise<{ value: T; directFallback: boolean }> {
  if (!enabled) return { value: await attempt(false), directFallback: false };
  try { return { value: await attempt(true), directFallback: false }; }
  catch (error) {
    if (!allowFallback || (error instanceof AppError && error.kind !== 'network')) throw error;
    try { return { value: await attempt(false), directFallback: true }; }
    catch (directError) {
      if (directError instanceof AppError && directError.kind !== 'network') throw directError;
      throw new AppError('订阅代理下载和直连下载均失败，原有订阅未更改。', 'network');
    }
  }
}

type NodeEntry = Record<string, unknown> & { name: string; type: string };
export function parseSubscription(input: string): NodeEntry[] {
  if (Buffer.byteLength(input) > MAX_SUBSCRIPTION) throw new AppError('订阅内容超过 4 MB。');
  let doc: unknown;
  try { doc = parse(input, { maxAliasCount: 20, uniqueKeys: true }); }
  catch { throw new AppError('订阅不是有效的 Clash YAML 配置。'); }
  const value = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).proxies : undefined;
  if (!Array.isArray(value) || !value.length || value.length > 5000) throw new AppError('订阅需要包含 proxies 节点列表（1–5000 个节点）。');
  const names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('订阅包含无效节点。');
    const node = item as Record<string, unknown>;
    if (typeof node.name !== 'string' || !node.name.trim() || node.name.length > 200 || /[\u0000-\u001f]/.test(node.name) ||
        typeof node.type !== 'string' || !node.type.trim() || names.has(node.name) || ['DIRECT', 'REJECT', 'PASS', 'GLOBAL', 'PLUGIN_PROXY'].includes(node.name)) {
      throw new AppError('订阅包含无效、重复或保留的节点名称。');
    }
    names.add(node.name);
    return node as NodeEntry;
  });
}

async function reservePort(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port');
  return { port: address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

export class MihomoManager implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private agent: ProxyAgent | undefined;
  private localAgent: Agent | undefined;
  private proxyAddress: string | undefined;
  private controller: string | undefined;
  private secret: string | undefined;
  private nodes: string[] = [];
  private starting: Promise<void> | undefined;
  private generation = 0;
  private enabled = false;
  private readonly directory: string;

  constructor(private readonly context: vscode.ExtensionContext, private readonly http: HttpClient) {
    this.directory = join(context.globalStorageUri.fsPath, 'mihomo', randomUUID());
  }

  async initialize(): Promise<void> {
    if (this.context.globalState.get<boolean>(ENABLED_KEY) === true) {
      this.enabled = true;
      this.installTransport();
      await this.start();
    }
  }

  private installTransport(): void {
    this.http.setModelFetch(async (input, init) => {
      await this.start();
      if (!this.agent || !this.child || this.child.exitCode !== null || this.child.killed) throw new AppError('Mihomo 代理不可用，模型请求已停止。', 'network');
      return fetch(input, { ...init, dispatcher: this.agent } as RequestInit);
    });
  }

  async setSubscription(url: string, allowFallback = false): Promise<SubscriptionResult> {
    let parsed: URL;
    try { parsed = new URL(url.trim()); } catch { throw new AppError('请输入有效的 HTTPS 订阅链接。'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new AppError('订阅链接必须使用 HTTPS，且不能包含 URL 用户名或密码。');
    const result = await withSubscriptionFallback(this.enabled, allowFallback, async proxy => {
      if (proxy) await this.start();
      if (proxy && !this.agent) throw new AppError('代理尚未启动，订阅下载失败。', 'network');
      const { Agent } = await import('undici');
      const directAgent = proxy ? undefined : new Agent();
      try {
        const dispatcher = proxy ? this.agent : directAgent;
        const timeout = AbortSignal.timeout(30000);
        let current = parsed;
        let response: Response;
        for (let redirects = 0; ; redirects++) {
          response = await fetch(current, { redirect: 'manual', signal: timeout, headers: { 'User-Agent': 'Clash.Meta' }, dispatcher } as RequestInit);
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects >= 4) throw new AppError('订阅重定向无效或次数过多。');
          const next = new URL(location, current);
          if (next.protocol !== 'https:' || next.username || next.password) throw new AppError('订阅只允许重定向到 HTTPS 地址。');
          current = next;
        }
        if (!response.ok || !response.body) throw new AppError(`下载订阅失败（HTTP ${response.status}）。`, 'network');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
            if (size > MAX_SUBSCRIPTION) throw new AppError('订阅内容超过 4 MB。'); chunks.push(part.value); }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        return Buffer.concat(chunks).toString('utf8');
      } finally { await directAgent?.close().catch(() => undefined); }
    });
    const content = result.value;
    const nodes = parseSubscription(content);
    await this.context.secrets.store(SUBSCRIPTION_KEY, JSON.stringify({ url: parsed.href, content }));
    if (this.enabled) { await this.stopProcess(); await this.start(); }
    return { count: nodes.length, directFallback: result.directFallback };
  }

  async importFile(content: string): Promise<number> {
    const nodes = parseSubscription(content);
    await this.context.secrets.store(SUBSCRIPTION_KEY, JSON.stringify({ content }));
    if (this.enabled) { await this.stopProcess(); await this.start(); }
    return nodes.length;
  }

  async refreshSubscription(): Promise<SubscriptionResult> {
    const raw = await this.context.secrets.get(SUBSCRIPTION_KEY);
    if (!raw) throw new AppError('请先导入 Clash 订阅。');
    const saved = JSON.parse(raw) as { url?: unknown };
    if (typeof saved.url !== 'string') throw new AppError('当前配置从本地文件导入；请先通过代理导入订阅链接。');
    return this.setSubscription(saved.url, true);
  }

  async enable(): Promise<void> {
    this.enabled = true; this.installTransport();
    await this.context.globalState.update(ENABLED_KEY, true);
    await this.start();
  }
  async disable(): Promise<void> {
    this.enabled = false; this.http.setModelFetch(undefined);
    await this.context.globalState.update(ENABLED_KEY, false);
    await this.stopProcess();
  }
  isEnabled(): boolean { return this.enabled; }

  async start(): Promise<void> {
    if (!this.enabled) throw new AppError('请先启用插件代理。');
    if (this.child && this.child.exitCode === null && !this.child.killed && this.agent) return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.starting = this.launch(generation).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch(generation: number): Promise<void> {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new AppError('当前安装包只内置 Windows x64 Mihomo 核心。');
    const raw = await this.context.secrets.get(SUBSCRIPTION_KEY);
    if (!raw) throw new AppError('请先导入 Clash 订阅。');
    const saved = JSON.parse(raw) as { content?: unknown };
    if (typeof saved.content !== 'string') throw new AppError('保存的订阅无效，请重新导入。');
    const nodes = parseSubscription(saved.content); this.nodes = nodes.map(node => node.name);
    const selected = this.context.globalState.get<string>(SELECTED_KEY);
    const mixed = await reservePort(); let control: Awaited<ReturnType<typeof reservePort>> | undefined;
    const path = join(this.directory, 'config.yaml');
    try {
      control = await reservePort();
      const secret = randomBytes(32).toString('hex');
      await mkdir(this.directory, { recursive: true });
      await writeFile(path, stringify({ 'mixed-port': mixed.port, 'allow-lan': false, 'bind-address': '127.0.0.1',
        mode: 'rule', 'log-level': 'silent', 'external-controller': `127.0.0.1:${control.port}`, secret,
        tun: { enable: false }, dns: { enable: false }, proxies: nodes,
        'proxy-groups': [{ name: 'PLUGIN_PROXY', type: 'select', proxies: this.nodes,
          ...(selected && this.nodes.includes(selected) ? { 'default-selected': selected } : {}) }], rules: ['MATCH,PLUGIN_PROXY'] }), { mode: 0o600 });
      await mixed.close(); await control.close();
      if (!this.enabled || generation !== this.generation) throw new AppError('代理启动已取消。', 'cancelled');
      const executable = this.context.asAbsolutePath('resources/mihomo/win32-x64/mihomo-windows-amd64-compatible.exe');
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) delete env[key];
      const { Agent } = await import('undici');
      this.localAgent = new Agent();
      const child = spawn(executable, ['-d', this.directory, '-f', path], { windowsHide: true, stdio: 'ignore', env });
      this.child = child; this.controller = `http://127.0.0.1:${control.port}`; this.secret = secret;
      let spawnError: Error | undefined; child.once('error', error => { spawnError = error; });
      for (let i = 0; i < 60; i++) {
        if (!this.enabled || generation !== this.generation) throw new AppError('代理启动已取消。', 'cancelled');
        if (spawnError || child.exitCode !== null) throw new AppError('Mihomo 启动失败，请检查订阅节点配置。', 'network');
        try {
          await this.controllerRequest('/version');
          const { ProxyAgent } = await import('undici');
          this.proxyAddress = `http://127.0.0.1:${mixed.port}`;
          this.agent = new ProxyAgent(this.proxyAddress);
          return;
        } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      throw new AppError('Mihomo 启动超时，请检查订阅节点配置或端口占用。', 'network');
    } catch (error) { await mixed.close().catch(() => undefined); await control?.close().catch(() => undefined); await this.stopProcess(); throw error; }
    finally { await unlink(path).catch(() => undefined); }
  }

  private async controllerRequest(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.controller || !this.secret) throw new AppError('代理尚未启动。');
    const response = await fetch(`${this.controller}${path}`, { ...init, redirect: 'error', dispatcher: this.localAgent,
      headers: { Authorization: `Bearer ${this.secret}`, ...init.headers }, signal: AbortSignal.timeout(5000) } as RequestInit);
    if (!response.ok) throw new AppError(`Mihomo 控制请求失败（HTTP ${response.status}）。`, 'network');
    return response;
  }
  async listNodes(): Promise<{ names: string[]; selected?: string }> {
    await this.start();
    const response = await this.controllerRequest('/proxies/PLUGIN_PROXY');
    const data = await response.json() as { now?: unknown };
    return { names: [...this.nodes], ...(typeof data.now === 'string' ? { selected: data.now } : {}) };
  }
  async selectNode(name: string): Promise<void> {
    await this.start(); if (!this.nodes.includes(name)) throw new AppError('选择的节点不存在。');
    await this.controllerRequest('/proxies/PLUGIN_PROXY', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    // New requests must not reuse a keep-alive tunnel established through the old node.
    const previous = this.agent;
    if (!this.proxyAddress) throw new AppError('代理尚未启动。');
    const { ProxyAgent } = await import('undici');
    this.agent = new ProxyAgent(this.proxyAddress);
    void previous?.close().catch(() => undefined);
    await this.context.globalState.update(SELECTED_KEY, name);
  }
  async exitIp(): Promise<string> {
    await this.start(); if (!this.agent) throw new AppError('代理尚未启动。');
    const response = await fetch('https://api.ipify.org?format=json', { dispatcher: this.agent, redirect: 'error', signal: AbortSignal.timeout(15000) } as RequestInit);
    if (!response.ok) throw new AppError(`出口 IP 查询失败（HTTP ${response.status}）。`, 'network');
    const data = JSON.parse(await readLimited(response, 1024)) as { ip?: unknown };
    if (typeof data.ip !== 'string' || !isIP(data.ip)) throw new AppError('出口 IP 查询返回了无效结果。');
    return data.ip;
  }
  private async stopProcess(): Promise<void> {
    this.generation++;
    const agent = this.agent; this.agent = undefined; this.proxyAddress = undefined; this.controller = undefined; this.secret = undefined;
    const localAgent = this.localAgent; this.localAgent = undefined;
    const child = this.child; this.child = undefined;
    child?.kill();
    await agent?.close().catch(() => undefined);
    await localAgent?.close().catch(() => undefined);
  }
  dispose(): void { this.enabled = false; this.http.setModelFetch(undefined); void this.stopProcess(); }
}
