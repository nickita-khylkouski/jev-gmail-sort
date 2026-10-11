// The service worker talks to the local Jev server (it holds the read-only Gmail token and the Jev
// key), so the extension needs no Google sign-in. Host permission lets it reach localhost without CORS.
const SERVER = "http://localhost:8383";

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "spellcheck") {
    fetch(`${SERVER}/api/spellcheck`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: msg.draft, context: msg.context }), signal: AbortSignal.timeout(9000)
    }).then(async (response) => {
      const result = await response.json();
      reply(response.ok ? result : { error: result.error || "Jev spell check failed. Your draft is unchanged." });
    }).catch(() => reply({ error: "Can't reach Jev spell check. Start the existing server with: bun run server.ts" }));
    return true;
  }
  if (msg.type !== "recent") return;
  fetch(`${SERVER}/api/recent?hours=${msg.hours || 24}${msg.refresh ? "&refresh=1" : ""}`)
    .then((r) => r.json())
    .then(reply, (e) => reply({ error: `Can't reach the Jev server on localhost:8383 (${e.message}). Start it with: bun run server.ts` }));
  return true;
});

// Analysis streams over a long-lived port: SSE from the server, one message per event.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jev") return;
  const ctl = new AbortController();
  port.onDisconnect.addListener(() => ctl.abort());
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "analyze") return;
    try {
      const qs = new URLSearchParams({ src: "recent", hours: String(msg.hours || 24), algo: msg.algo || "auto", q: msg.q || "" });
      const res = await fetch(`${SERVER}/api/analyze?${qs}`, { signal: ctl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) port.postMessage(JSON.parse(chunk.slice(6)));
        }
      }
    } catch (e) {
      if (!ctl.signal.aborted) port.postMessage({ type: "fatal", message: `Can't reach the Jev server on localhost:8383 (${e.message})` });
    }
  });
});

// Presence contains no email text. Actual capture/sort is requested only by a native shortcut.
const companionClient = crypto.randomUUID();
async function companionPost(route, value, timeout = 5000) {
  const response = await fetch(`${SERVER}/api/companion/extension/${route}`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: companionClient, ...value }), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error("Companion server unavailable");
  return response.json();
}
let activeGmailTab = null;
let executing = null;
function cancelCommand(command) {
  if (!command || command.cancelled) return;
  command.cancelled = true;
  void chrome.tabs.sendMessage(command.tab, { type: "glanceCancel", id: command.id }).catch(() => {});
  command.release({ error: "Gmail shortcut cancelled." });
}
let presencePending = null;
function companionPresence() {
  return presencePending ||= samplePresence().finally(() => { presencePending = null; });
}
async function samplePresence() {
  const current = executing;
  try {
    const window = await chrome.windows.getLastFocused();
    const [tab] = window.focused ? await chrome.tabs.query({ active: true, windowId: window.id }) : [];
    const presence = tab && await chrome.tabs.sendMessage(tab.id, { type: "glancePresence" }).catch(() => null);
    activeGmailTab = presence?.gmail ? tab.id : null;
    const presenceResult = await companionPost("presence", { active: activeGmailTab !== null, tab: activeGmailTab });
    if (current && executing === current && (presenceResult.command !== current.id || activeGmailTab !== current.tab)) cancelCommand(current);
  } catch { activeGmailTab = null; }
}
async function companionLoop() {
  for (;;) {
    try {
      await companionPresence();
      const { command } = await companionPost("next", {}, 23000);
      if (!command) continue;
      let result;
      try {
        await companionPresence();
        if (activeGmailTab === null || activeGmailTab !== command.tab) throw new Error("Gmail is no longer focused.");
        let release;
        const cancelled = new Promise((resolve) => { release = resolve; });
        const current = executing = { id: command.id, tab: command.tab, release, cancelled: false };
        const timer = setTimeout(() => cancelCommand(current), 45000);
        try {
          result = await Promise.race([cancelled, chrome.tabs.sendMessage(current.tab, { type: "glanceLookup", id: command.id, mode: command.mode, criterion: command.criterion })]);
        } finally { clearTimeout(timer); if (executing === current) executing = null; }
      } catch { result = { error: "The active Gmail tab could not complete this shortcut. Refresh Gmail and retry." }; }
      // A cancelled native request may already have released this job; don't stall the next poll.
      await companionPost("result", { id: command.id, result }).catch(() => {});
    } catch { await new Promise((resolve) => setTimeout(resolve, 3000)); }
  }
}
setInterval(() => void companionPresence(), 2000);
void companionLoop();
