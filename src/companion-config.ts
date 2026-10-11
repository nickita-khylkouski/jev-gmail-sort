import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function companionToken(path = resolve("data/companion-token")) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(randomBytes(32).toString("hex")); } finally { await file.close(); }
  } catch (error: any) { if (error.code !== "EEXIST") throw error; }
  await chmod(path, 0o600);
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid companion token. Remove data/companion-token and pair again.");
  return token;
}
