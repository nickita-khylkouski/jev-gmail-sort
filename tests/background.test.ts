import { test, expect } from 'bun:test';

const sourcePath = new URL('../extension/background.js', import.meta.url);
const source = (await Bun.file(sourcePath).text())
  .replace('setInterval(() => void companionPresence(), 2000);', '')
  .replace('void companionLoop();', '');
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 1)); }
  throw new Error('Mock did not reach expected state');
}
function harness(fetch: any, send?: any) {
  const messages: any[] = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onConnect: { addListener() {} } },
    windows: { getLastFocused: async () => ({ focused: true, id: 1 }) },
    tabs: { query: async () => [{ id: 17 }], sendMessage: async (tab: number, msg: any) => {
      messages.push({ tab, ...msg });
      if (msg.type === 'glancePresence') return { gmail: true };
      return send ? send(tab, msg) : {};
    } },
  };
  const api = Function('chrome', 'fetch', source + '\nreturn { presence: companionPresence, loop: companionLoop, start(c) { executing = c; }, current() { return executing; } };')(chrome, fetch);
  return { ...api, messages };
}

test('overlapping presence calls share a sample and an old response cannot cancel a new command', async () => {
  const held = deferred<Response>(); let requests = 0;
  const api = harness(async () => { requests++; return held.promise; });
  const a = api.presence(), b = api.presence();
  expect(a).toBe(b);
  await until(() => requests === 1);
  let cancelled = false;
  api.start({ id: 'new-command', tab: 17, cancelled: false, release() { cancelled = true; } });
  held.resolve(Response.json({ ok: true, command: null }));
  await Promise.all([a, b]);
  expect(cancelled).toBe(false);
  expect(api.messages.some((m: any) => m.type === 'glanceCancel')).toBe(false);
});

test('a heartbeat for an older executing object cannot cancel its replacement', async () => {
  const held = deferred<Response>(); let requests = 0;
  const api = harness(async () => { requests++; return held.promise; });
  api.start({ id: 'old-command', tab: 17, cancelled: false, release() {} });
  const presence = api.presence(); await until(() => requests === 1);
  let cancelled = false;
  api.start({ id: 'new-command', tab: 17, cancelled: false, release() { cancelled = true; } });
  held.resolve(Response.json({ ok: true, command: null })); await presence;
  expect(cancelled).toBe(false);
});

test('native cancellation reaches the content script and releases polling for the next command', async () => {
  let hubCommand: string | null = 'first-command', next = 0;
  const results: any[] = [], never = deferred();
  const commands = [
    { id: 'first-command', tab: 17, mode: 'screen', criterion: '' },
    { id: 'second-command', tab: 17, mode: 'cursor', criterion: '' },
  ];
  const api = harness(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/presence')) return Response.json({ ok: true, command: hubCommand });
    if (url.endsWith('/result')) { results.push(body); return Response.json({ ok: true }); }
    if (url.endsWith('/next')) {
      const command = commands[next++];
      if (!command) return never.promise;
      hubCommand = command.id;
      return Response.json({ command });
    }
    throw new Error('Unexpected request');
  }, (_tab: number, msg: any) => {
    if (msg.type === 'glanceLookup' && msg.id === 'first-command') return never.promise;
    return { threadID: 'abc12345' };
  });
  void api.loop();
  await until(() => api.messages.some((m: any) => m.type === 'glanceLookup' && m.id === 'first-command'));
  hubCommand = null;
  await api.presence();
  await until(() => results.length === 2);
  expect(api.messages.some((m: any) => m.type === 'glanceCancel' && m.id === 'first-command')).toBe(true);
  expect(results[0].result.error).toContain('cancelled');
  expect(results[1].id).toBe('second-command');
  expect(results[1].result.threadID).toBe('abc12345');
  expect(next).toBeGreaterThanOrEqual(2);
});
