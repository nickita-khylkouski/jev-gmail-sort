import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'glance-http-cancel-'));
const originalFetch = globalThis.fetch, originalServe = Bun.serve, originalCwd = process.cwd();
let server: any, providerStarted = 0, providerAborted = 0;
try {
  process.chdir(dir);
  process.env.PORT = '0'; process.env.TYPESAFE_API_KEY = 'synthetic'; process.env.EXA_API_KEY = 'synthetic';
  process.env.GOOGLE_TOKEN_FILE = join(dir, 'synthetic.json');
  await writeFile(process.env.GOOGLE_TOKEN_FILE, JSON.stringify({ client_id: 'synthetic', client_secret: 'synthetic', refresh_token: 'synthetic' }));
  await writeFile(join(dir, 'owner.example.json'), JSON.stringify({ name: 'Synthetic Owner', about: 'Invented audit fixture' }));
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'synthetic', scope: 'https://www.googleapis.com/auth/gmail.readonly', expires_in: 3600 });
    if (url.includes('gmail.googleapis.com')) {
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'owner@example.test' });
      if (url.includes('/labels/')) return Response.json({ threadsTotal: 3 });
      if (url.includes('/threads?')) return Response.json({ threads: ['abc12345', 'abc12346', 'abc12347'].map(id => ({ id })) });
      return Response.json({ messages: [{ internalDate: String(Date.now()), labelIds: ['INBOX'], snippet: 'Synthetic message', payload: { mimeType: 'text/plain', body: { data: Buffer.from('Synthetic message').toString('base64url') }, headers: [{ name: 'Subject', value: 'Synthetic subject' }, { name: 'From', value: 'Alex <alex@example.test>' }] } }] });
    }
    if (url.includes('api.typesafe.ai')) {
      providerStarted++;
      return new Promise((_resolve, reject) => {
        const abort = () => { providerAborted++; reject(init.signal.reason); };
        if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error('Unexpected external request blocked');
  };
  Bun.serve = ((options: any) => { server = originalServe(options); return server; }) as any;
  await import('../../server.ts');
  const ctl = new AbortController();
  const response = await originalFetch(`http://127.0.0.1:${server.port}/api/analyze?src=recent&algo=full`, { signal: ctl.signal });
  const reader = response.body!.getReader();
  await reader.read();
  for (let i = 0; providerStarted === 0 && i < 100; i++) await Bun.sleep(1);
  if (!providerStarted) throw new Error('Mock provider did not start');
  ctl.abort();
  for (let i = 0; providerAborted < providerStarted && i < 200; i++) await Bun.sleep(1);
  console.log(JSON.stringify({ providerStarted, providerAborted, allCancelled: providerStarted === providerAborted }));
  if (providerStarted !== providerAborted) throw new Error('Actual HTTP disconnect failed to cancel every active provider call');
} finally {
  server?.stop(true); globalThis.fetch = originalFetch; Bun.serve = originalServe;
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
}
