import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** The ORT runtime is served from public/ort (wasmPaths is always set), so the bundler's own copy is dead weight. */
const dropBundledOrtWasm = (): Plugin => ({
  name: "drop-bundled-ort-wasm",
  apply: "build",
  generateBundle(_, bundle) {
    for (const key of Object.keys(bundle)) {
      if (/assets\/ort-wasm-simd-threaded.*\.wasm$/.test(key)) delete bundle[key];
    }
  },
});

const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || String(Date.now());

/** Open web tabs poll this file to notice a newer deploy. */
const emitVersion = (): Plugin => ({
  name: "emit-version",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
  },
});

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), dropBundledOrtWasm(), emitVersion()],
  define: {
    __TARGET__: JSON.stringify(mode === "extension" ? "extension" : mode === "android" ? "android" : "web"),
    __BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    outDir: mode === "extension" ? "dist-ext" : mode === "android" ? "dist-android" : "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    modulePreload: { polyfill: false },
    rollupOptions: mode === "extension" || mode === "android" ? undefined : { input: { main: "index.html", attend: "attend.html" } },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  server: {
    port: 5317,
    proxy: {
      "^/api/(attendance|transcribe|mom-template)": {
        target: process.env.NOTESY_API_TARGET ?? "https://notesy-three.vercel.app",
        changeOrigin: true,
        headers: process.env.NOTESY_API_BYPASS ? { "x-vercel-protection-bypass": process.env.NOTESY_API_BYPASS } : {},
      },
      "/cursor-api": {
        target: process.env.CURSOR_API_TARGET ?? "https://api.cursor.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/cursor-api/, ""),
      },
    },
  },
}));
