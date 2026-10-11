import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([false, true])("extension setup with Gmail credentials: %s", async (gmail) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-setup-"));
  try {
    const token = join(dir, "google.json");
    const google = { client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh", token_uri: "https://oauth2.googleapis.com/token" };
    if (gmail) await Bun.write(token, JSON.stringify(google));
    const proc = Bun.spawn([process.execPath, new URL("../scripts/secrets.ts", import.meta.url).pathname], {
      cwd: dir, env: { ...process.env, GOOGLE_TOKEN_FILE: gmail ? token : "", TYPESAFE_API_KEY: "fixture-jev", OPENAI_API_KEY: "fixture-openai" }, stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const generated = await import(join(dir, "extension/secrets.js"));
    expect(generated.default.jevKey).toBe("fixture-jev");
    expect(generated.default.openaiKey).toBe("fixture-openai");
    expect(generated.default.google).toEqual(gmail ? google : { client_id: "", client_secret: "", refresh_token: "", token_uri: google.token_uri });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
