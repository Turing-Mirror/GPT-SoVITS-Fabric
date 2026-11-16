import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { run } from "@tauri-apps/cli";

const app = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(app, process.argv[2] ?? "src/assets/brand/gsvf-main-icon.svg");
const staging = resolve(app, "../data/brand-icons");
const output = resolve(app, "src-tauri/icons");
await mkdir(output, { recursive: true });
await run(["icon", source, "--output", staging]);
// This desktop application does not ship the generated Android/iOS folders.
for (const entry of await readdir(staging, { withFileTypes: true })) {
  if (entry.isFile() && /\.(png|ico|icns)$/.test(entry.name)) {
    await copyFile(resolve(staging, entry.name), resolve(output, entry.name));
  }
}
await copyFile(resolve(output, "128x128@2x.png"), resolve(output, "icon-256.png"));
