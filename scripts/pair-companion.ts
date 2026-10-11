import { companionToken } from "../src/companion-config";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const dir = join(homedir(), "Library/Application Support/JevGlance");
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = join(dir, "connection.json");
await writeFile(file, JSON.stringify({ server: `http://127.0.0.1:${Number(process.env.PORT || 8383)}`, token: await companionToken(), extension: resolve("extension") }), { mode: 0o600 });
await chmod(file, 0o600);
console.log("Mac helper paired with this repository's local server. No provider keys copied.");
