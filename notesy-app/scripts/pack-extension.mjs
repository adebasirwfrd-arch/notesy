import { copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-ext");
if (!existsSync(join(dist, "index.html"))) {
  console.error("dist-ext/index.html missing; run vite build --mode extension first");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
copyFileSync(join(root, "extension/background.js"), join(dist, "background.js"));

const zip = join(root, `notesy-extension-${pkg.version}.zip`);
rmSync(zip, { force: true });
try {
  execFileSync("zip", ["-qr", zip, "."], { cwd: dist, stdio: "inherit" });
  console.log(`Extension ready: ${dist}\nWeb Store package: ${zip}`);
} catch {
  console.log(`Extension ready: ${dist} (zip tool not found, package skipped)`);
}
