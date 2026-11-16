import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSubscription, withSubscriptionFallback } from '../src/mihomo';
import { MihomoManager } from '../src/mihomo';
import { HttpClient } from '../src/http';
import { API, TOKEN, AppError } from '../src/core';
import { fake, json, signal } from './helpers';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';

test('accepts Clash YAML nodes and ignores subscription-supplied global settings', () => {
  const nodes = parseSubscription('mixed-port: 7890\ntun:\n  enable: true\nproxies:\n  - name: Test\n    type: http\n    server: 127.0.0.1\n    port: 1234\n');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.name, 'Test');
  assert.equal('tun' in nodes[0]!, false);
});

test('subscription update falls back once on network failure but not on invalid data', async () => {
  const paths: boolean[] = [];
  const result = await withSubscriptionFallback(true, true, async proxy => {
    paths.push(proxy); if (proxy) throw new AppError('offline', 'network'); return 'subscription';
  });
  assert.deepEqual(result, { value: 'subscription', directFallback: true });
  assert.deepEqual(paths, [true, false]);
  await assert.rejects(withSubscriptionFallback(true, true, async () => { throw new AppError('invalid'); }), /invalid/);
  await assert.rejects(withSubscriptionFallback(true, false, async () => { throw new AppError('offline', 'network'); }), /offline/);
  await assert.rejects(withSubscriptionFallback(true, true, async () => { throw new Error('offline'); }), /均失败/);
});

test('real Mihomo routes model traffic to the chosen local upstream and leaves login direct', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
  const proxy = createServer(); let connects = 0;
  proxy.on('connect', (_request, socket) => { connects++; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  const secrets = new Map<string, string>([['chatgptSub.mihomo.subscription', JSON.stringify({ url: 'https://example.test/', content: `proxies:\n - name: local-test\n   type: http\n   server: 127.0.0.1\n   port: ${address.port}\n` })]]);
  const state = new Map<string, unknown>();
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-mihomo-test-'));
  const context = { globalStorageUri: { fsPath: directory }, secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } },
    globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
    asAbsolutePath: (path: string) => join(process.cwd(), path) } as unknown as vscode.ExtensionContext;
  let direct = 0; const http = new HttpClient(fake(() => { direct++; return json({ ok: true }); }));
  const manager = new MihomoManager(context, http);
  try {
    await manager.enable();
    assert.deepEqual(await manager.listNodes(), { names: ['local-test'], selected: 'local-test' });
    await manager.selectNode('local-test');
    await new Promise(resolve => setTimeout(resolve, 250));
    await http.form(TOKEN, new URLSearchParams({ grant_type: 'authorization_code' }), signal(), true);
    await assert.rejects(http.json(`${API}/responses`, signal()));
    assert.equal(direct, 1);
    assert.ok(connects >= 1);
  } finally { await manager.disable(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});
test('rejects invalid, duplicate, reserved and oversized subscription input', () => {
  for (const input of ['proxies: []', 'proxies: [', 'proxies:\n - {name: PLUGIN_PROXY, type: http}',
    'proxies:\n - {name: node, type: http}\n - {name: node, type: http}', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseSubscription(input));
  }
});
