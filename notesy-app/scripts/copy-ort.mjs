import { copyFileSync, mkdirSync, realpathSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transformers = realpathSync(join(root, "node_modules/@huggingface/transformers"));
const candidates = [
  join(dirname(transformers), "onnxruntime-web/dist"),
  join(dirname(dirname(transformers)), "onnxruntime-web/dist"),
  join(root, "node_modules/onnxruntime-web/dist"),
];
const dist = candidates.find((p) => existsSync(join(p, "ort-wasm-simd-threaded.asyncify.wasm")));
if (!dist) {
  console.error("onnxruntime-web dist not found next to @huggingface/transformers");
  process.exit(1);
}
const out = join(root, "public/ort");
mkdirSync(out, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  copyFileSync(join(dist, f), join(out, f));
}
console.log(`ORT runtime copied from ${dist}`);
