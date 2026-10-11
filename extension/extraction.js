// Stream OpenAI's JSON-lines extraction. The panel owns the page and UI; this owns the request.
export async function extractItems(page, onItem, { key, prompt, models, signal, timeoutMs = 45000 }) {
  if (!key) throw new Error("Add an OpenAI key in the settings to read pages.");
  const ctl = new AbortController();
  const abort = () => ctl.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error("Reading this page timed out. Try again.")), timeoutMs);
  let reader;
  try {
    ctl.signal.throwIfAborted();
    const ask = (model) => fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model, stream: true, reasoning_effort: "none", max_completion_tokens: 8000,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: `Page: ${page.title}\nURL: ${page.url}\n\n${page.text}` },
        ],
      }),
    });
    let res = await ask(models[0]);
    if (res.status === 400 || res.status === 404) {
      await res.body?.cancel();
      res = await ask(models[1]);
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!res.body) throw new Error("OpenAI returned an empty response. Try again.");

    let noun = "item", out = "", sse = "", finished = false;
    const take = (line) => {
      line = line.trim().replace(/^```\w*|```$/g, "").replace(/,$/, "");
      if (!line.startsWith("{")) return;
      try {
        const o = JSON.parse(line);
        if (o.noun) noun = String(o.noun).toLowerCase();
        else if (o.title) onItem({ title: String(o.title), detail: String(o.detail || ""), anchor: String(o.anchor || "") });
      } catch {}
    };
    const event = (line) => {
      line = line.trim();
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { finished = true; return; }
      const packet = JSON.parse(data);
      if (packet.error) throw new Error(`OpenAI: ${packet.error.message || "stream failed"}`);
      const choice = packet.choices?.[0];
      if (choice?.finish_reason && choice.finish_reason !== "stop") {
        throw new Error(choice.finish_reason === "length" ? "OpenAI stopped before finishing the items. Try a smaller page." : `OpenAI stopped reading this page (${choice.finish_reason}).`);
      }
      out += choice?.delta?.content || "";
      let j;
      while ((j = out.indexOf("\n")) >= 0) { take(out.slice(0, j)); out = out.slice(j + 1); }
      if (choice?.finish_reason === "stop") finished = true;
    };
    const consume = () => {
      let i;
      while (!finished && (i = sse.indexOf("\n")) >= 0) { event(sse.slice(0, i)); sse = sse.slice(i + 1); }
    };
    reader = res.body.getReader();
    const dec = new TextDecoder();
    while (!finished) {
      const { done, value } = await reader.read();
      ctl.signal.throwIfAborted();
      if (done) {
        sse += dec.decode();
        consume();
        if (!finished && sse.trim()) event(sse);
        break;
      }
      sse += dec.decode(value, { stream: true });
      consume();
    }
    if (!finished) throw new Error("OpenAI's response was interrupted. Try again.");
    take(out);
    return noun;
  } catch (e) {
    if (ctl.signal.aborted) throw ctl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
  }
}
