import { timingSafeEqual } from "node:crypto";
import { ContextError, inspectEmail, lookupContext } from "./context";
import { checkSpelling } from "./spellcheck";
import { localOrigin } from "./local-origin";
export { localOrigin } from "./local-origin";

type Presence = { client: string; active: boolean; tab: number | null; at: number };
type Job = { id: string; client: string; tab: number | null; mode: string; criterion: string; sent: boolean; finish: (value: any) => void };
const clientID = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(value);
export async function boundedJSON(req: Request) {
  if (req.method !== "POST") throw new ContextError("Use POST.", 405);
  if (req.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") throw new ContextError("JSON required.", 415);
  const reader = req.body?.getReader();
  if (!reader) throw new ContextError("Request body required.");
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 64_000) { await reader.cancel(); throw new ContextError("Request too large.", 413); }
    parts.push(value);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new ContextError("Invalid JSON."); }
}

// A command carries no email text. Only the focused Gmail tab can claim a pending command.
export class CompanionHub {
  presence: Presence | null = null;
  private job: Job | null = null;
  private wake: (() => void) | null = null;
  get active() { return !!this.presence?.active && Date.now() - this.presence.at < 6000; }
  get connected() { return !!this.presence && Date.now() - this.presence.at < 6000; }
  current(client: string) { return this.job?.client === client ? this.job.id : null; }
  heartbeat(client: string, active: boolean, tab: number | null = null) {
    if (active || !this.active || this.presence?.client === client) this.presence = { client, active, tab, at: Date.now() };
    this.wake?.();
  }
  async next(client: string, signal: AbortSignal) {
    if (signal.aborted) return null;
    const ready = () => !signal.aborted && this.active && this.presence?.client === client && this.job?.client === client && this.presence.tab === this.job.tab && !this.job.sent;
    if (!ready()) await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); if (this.wake === finish) this.wake = null; resolve(); };
      const timer = setTimeout(finish, 18_000); this.wake?.(); this.wake = finish;
      signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
    });
    if (!ready()) return null;
    this.job!.sent = true;
    const { id, tab, mode, criterion } = this.job!; return { id, tab, mode, criterion };
  }
  async request(mode: string, criterion: string, signal: AbortSignal) {
    if (!this.active) throw new ContextError("Focus Gmail and reload the existing Jev extension first.", 409);
    if (this.job) throw new ContextError("A Gmail shortcut is already running.", 409);
    return new Promise<any>((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (value: any) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (this.job?.id === id) this.job = null;
        value?.error ? reject(new ContextError(String(value.error).slice(0, 240), 502)) : resolve(value);
      };
      const abort = () => finish({ error: "Gmail shortcut cancelled." });
      const timer = setTimeout(() => finish({ error: "Gmail shortcut timed out. Check the extension and server." }), 45_000);
      this.job = { id, client: this.presence!.client, tab: this.presence!.tab, mode, criterion, sent: false, finish };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else this.wake?.();
    });
  }
  respond(client: string, id: string, value: any) {
    if (!this.job || this.job.client !== client || this.job.id !== id || !this.job.sent) throw new ContextError("Expired Gmail command.", 409);
    this.job.finish(value);
  }
}

export function companionHandler(options: { token: string; hub?: CompanionHub; recent: () => Promise<{ threads: any[] }>; thread?: (id: string, signal: AbortSignal) => Promise<any>; lookup?: typeof lookupContext; inspect?: typeof inspectEmail; spelling?: typeof checkSpelling }) {
  const hub = options.hub || new CompanionHub();
  return async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/api/companion/")) return null;
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    try {
      if (!localOrigin(req)) throw new ContextError("Origin denied.", 403);
      const extension = path.startsWith("/api/companion/extension/");
      if (!extension) {
        const auth = req.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
        if (!/^[a-f0-9]{64}$/.test(auth) || auth.length !== options.token.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(options.token))) throw new ContextError("Pair the Mac helper with this server first.", 401);
      }
      if (path === "/api/companion/health") {
        if (req.method !== "GET") throw new ContextError("Use GET.", 405);
        return json({ service: "jev-glance-v1", connected: hub.connected, active: hub.active,
          jev: !!process.env.TYPESAFE_API_KEY, exa: !!process.env.EXA_API_KEY });
      }
      const input = await boundedJSON(req);
      if (extension) {
        if (!clientID(input?.client)) throw new ContextError("Invalid extension session.");
        if (path.endsWith("/presence")) {
          const tab = Number.isInteger(input.tab) && input.tab >= 0 ? input.tab : null;
          if (input.active === true && tab === null) throw new ContextError("Invalid active Gmail tab.");
          hub.heartbeat(input.client, input.active === true, tab);
          return json({ ok: true, command: hub.current(input.client) });
        }
        if (path.endsWith("/next")) return json({ command: await hub.next(input.client, req.signal) });
        if (path.endsWith("/result")) { hub.respond(input.client, input.id, input.result); return json({ ok: true }); }
        throw new ContextError("Unknown extension route.", 404);
      }
      if (path === "/api/companion/context") return json(await (options.lookup || lookupContext)(input, { signal: req.signal }));
      if (path === "/api/companion/spellcheck") return json(await (options.spelling || checkSpelling)(input, { signal: req.signal }));
      if (path !== "/api/companion/gmail") throw new ContextError("Unknown companion route.", 404);
      if (!["screen", "cursor"].includes(input?.mode)) throw new ContextError("Unknown lookup mode.");
      const start = performance.now();
      const result = await hub.request(input.mode, typeof input.criterion === "string" ? input.criterion.slice(0, 300) : "", req.signal);
      if (!/^[a-f0-9]{6,32}$/i.test(result?.threadID || "")) throw new ContextError("Point at an email in the current inbox.", 422);
      const source = new URL(result.source);
      if (source.protocol !== "https:" || source.hostname !== "mail.google.com" || !/^\/mail\/u\/(?:\d+|[^/]+)\/$/.test(source.pathname) || source.hash !== `#inbox/${result.threadID}`) throw new ContextError("Invalid Gmail source.");
      const recent = input.mode === "screen" || !options.thread ? await options.recent() : null;
      const thread = input.mode === "cursor" && options.thread ? await options.thread(result.threadID, req.signal) : recent!.threads.find((t) => t.id === result.threadID);
      if (!thread) throw new ContextError("This email is not available in the server's inbox.", 422);
      const text = input.mode === "screen" ? `Read first: ${thread.subject.split(/\s+/).slice(0, 12).join(" ")}` : await (options.inspect || inspectEmail)(thread, { signal: req.signal });
      return json({ text, detail: thread.subject, source: source.href, from: thread.from?.name || "", count: input.mode === "screen" ? recent!.threads.length : 1, ms: Math.round(performance.now() - start) });
    } catch (error) {
      const known = error instanceof ContextError || (error instanceof Error && "status" in error);
      return json({ error: known ? (error as Error).message : "The companion request failed. Check the local server and try again." }, known ? Number((error as any).status) || 502 : 502);
    }
  };
}
