import { test, expect } from "bun:test";
import { candidates, checkSpelling, spellcheckRequest } from "../src/spellcheck";

const draft = "i reqest teh pemrisison to recieve your reply.";
function chooser(replacements: Record<string, string>, inspect = (_body: any) => {}) {
  return async (_url: any, init: any) => {
    const body = JSON.parse(init.body); inspect(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const original = q.instructions.at(-1).original;
      const replacement = replacements[original];
      const choice = Object.keys(q.criteria).find((id) => id !== "keep" && q.criteria[id] === `Replace only this span with: ${replacement}`) || "keep";
      return [id, { choice, confidence: 0.99, probabilities: { [choice]: 0.99 } }];
    }));
    return Response.json({ answers });
  };
}
test("local candidates include common typos and multiple transpositions", () => {
  const words = candidates(draft);
  for (const [original, replacement] of Object.entries({ i: "I", reqest: "request", teh: "the", pemrisison: "permission", recieve: "receive" })) {
    expect(words.find((word) => word.original === original)?.options).toContain(replacement);
  }
});
test("one Jev batch uses draft, purpose, subject and thread while preserving span offsets", async () => {
  let calls = 0;
  const result = await checkSpelling({ draft: "🙂 " + draft, context: { subject: "Meeting approval", purpose: "email to my professor", thread: "Please ask permission first.", recipients: "Professor" } }, {
    key: "synthetic-key", fetch: chooser({ i: "I", reqest: "request", teh: "the", pemrisison: "permission", recieve: "receive" }, (body) => {
      calls++; expect(body.model).toBe("jev-latest"); expect(body.state.context.purpose).toBe("email to my professor");
      expect(body.state.context.thread).toContain("permission");
      for (const q of Object.values(body.questions) as any[]) expect(q.criteria).toHaveProperty("keep");
    })
  });
  expect(calls).toBe(1); expect(result.changes).toHaveLength(5);
  let corrected = "🙂 " + draft;
  for (const change of [...result.changes].reverse()) {
    expect(corrected.slice(change.start, change.end)).toBe(change.original);
    corrected = corrected.slice(0, change.start) + change.replacement + corrected.slice(change.end);
  }
  expect(corrected).toBe("🙂 I request the permission to receive your reply.");
});
test("context can keep informal wording or choose a homophone without rewriting prose", async () => {
  const casual = await checkSpelling({ draft: "u wanna come?" }, { key: "synthetic", fetch: chooser({}) });
  expect(casual.changes).toEqual([]);
  const formal = await checkSpelling({ draft: "your welcome", context: { purpose: "a formal reply" } }, { key: "synthetic", fetch: chooser({ your: "you're" }) });
  expect(formal.changes[0].replacement).toBe("you're");
});
test("passwords, tokens, addresses, links, inline code and identifiers are protected", async () => {
  const secret = "password=teh-secret-value", token = "apikey_abcdefgh12345678";
  const data = `teh ${secret} ${token} person@example.com https://example.test/teh?q=private \`const teh = 1\` item123 camelCase`;
  expect(candidates(data).map((word) => word.original)).toEqual(["teh"]);
  await checkSpelling({ draft: data }, { key: "synthetic", fetch: chooser({ teh: "the" }, (body) => {
    const outgoing = JSON.stringify(body);
    for (const value of [secret, token, "person@example.com", "q=private", "const teh", "item123"]) expect(outgoing).not.toContain(value);
  }) });
});
test("standard bearer credentials are masked in drafts and writing context", async () => {
  const token = "abcdefghijklmnopqrstuvwxabcdefgh";
  const authorization = `Authorization: Bearer ${token}`;
  expect(candidates(authorization)).toEqual([]);
  await checkSpelling({ draft: `teh ${authorization}`, context: { purpose: `bearer ${token}` } }, {
    key: "synthetic", fetch: chooser({ teh: "the" }, (body) => expect(JSON.stringify(body)).not.toContain(token))
  });
});
test("protected inline markers also exclude adjacent partial words", () => {
  expect(candidates("permis__protected0__sion teh").map((word) => word.original)).toEqual(["teh"]);
});
test("low confidence or low selected probability leaves the draft unchanged", async () => {
  for (const answer of [{ choice: "fix_0", confidence: 0.2, probabilities: { fix_0: 0.99 } }, { choice: "fix_0", confidence: 0.99, probabilities: { fix_0: 0.6 } }]) {
    const result = await checkSpelling({ draft: "teh" }, { key: "synthetic", fetch: async () => Response.json({ answers: { word_0: answer } }) });
    expect(result.changes).toEqual([]);
  }
});
test("partial, unknown, and out-of-range provider decisions fail before edits are returned", async () => {
  for (const answers of [{}, { word_0: { choice: "injected", confidence: 1, probabilities: { injected: 1 } } }, { word_0: { choice: "keep", confidence: 5, probabilities: { keep: 1 } } }]) {
    await expect(checkSpelling({ draft: "teh" }, { key: "synthetic", fetch: async () => Response.json({ answers }) })).rejects.toThrow("incomplete");
  }
});
test("limits bound request size and provider work", async () => {
  await expect(checkSpelling({ draft: "x".repeat(12001) })).rejects.toThrow("12,000");
  expect(candidates("teh ".repeat(100))).toHaveLength(24);
  const result = await checkSpelling({ draft: "Hello Alex." }, { fetch: async () => { throw new Error("unexpected provider call"); } });
  expect(result.changes).toEqual([]);
});
test("provider failures do not expose credentials or response bodies", async () => {
  await expect(checkSpelling({ draft: "teh" }, { key: "synthetic-secret", fetch: async () => new Response("private server body", { status: 401 }) })).rejects.toThrow("Check the server's key");
  await expect(checkSpelling({ draft: "teh" }, { key: "synthetic", fetch: async () => { throw new Error("private network details"); } })).rejects.toThrow("connection");
});
test("HTTP route rejects wrong methods, web origins, oversized and malformed input", async () => {
  const request = (body: string, headers = {}) => new Request("http://localhost:8383/api/spellcheck", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
  expect((await spellcheckRequest(new Request("http://localhost:8383/api/spellcheck"))).status).toBe(405);
  expect((await spellcheckRequest(request("{}", { Origin: "https://evil.test" }))).status).toBe(403);
  expect((await spellcheckRequest(new Request("http://evil.test:8383/api/spellcheck", { method: "POST", headers: { Origin: "http://evil.test:8383", "Content-Type": "application/json" }, body: '{"draft":"Hello world"}' }))).status).toBe(403);
  expect((await spellcheckRequest(request('{"draft":"Hello world"}', { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
  expect((await spellcheckRequest(request('{"draft":"Hello world"}', { Origin: `chrome-extension://${"a".repeat(32)}`, "Sec-Fetch-Site": "cross-site" }))).status).toBe(200);
  expect((await spellcheckRequest(request("{}", { "Content-Type": "text/plain" }))).status).toBe(415);
  expect((await spellcheckRequest(request("{"))).status).toBe(400);
  expect((await spellcheckRequest(request("x".repeat(64001)))).status).toBe(413);
});
