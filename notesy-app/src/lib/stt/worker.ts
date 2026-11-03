import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

type LoadMsg = { type: "load"; model: string; device: "webgpu" | "wasm"; ortBase: string };
type RunMsg = { type: "run"; id: number; audio: Float32Array; language: string | null };
type InMsg = LoadMsg | RunMsg;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedKey = "";

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function load({ model, device, ortBase }: LoadMsg) {
  const key = `${model}|${device}`;
  if (asr && loadedKey === key) return post({ type: "ready", device });
  env.allowLocalModels = false;
  // MV3 extension CSP forbids blob: scripts, which the wasm cache uses to import the ORT factory.
  env.useWasmCache = false;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = {
      mjs: `${ortBase}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${ortBase}ort-wasm-simd-threaded.asyncify.wasm`,
    };
  }
  await asr?.dispose();
  asr = null;
  const files = new Map<string, { loaded: number; total: number }>();
  const dtype = device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8";
  asr = (await pipeline("automatic-speech-recognition", model, {
    device,
    dtype: dtype as never,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        let loaded = 0;
        let total = 0;
        files.forEach((f) => {
          loaded += f.loaded;
          total += f.total;
        });
        post({ type: "download", loaded, total });
      }
    },
  })) as AutomaticSpeechRecognitionPipeline;
  loadedKey = key;
  post({ type: "ready", device });
}

async function run({ id, audio, language }: RunMsg) {
  if (!asr) throw new Error("model not loaded");
  const out = (await asr(audio, {
    language: language ?? undefined,
    task: "transcribe",
    return_timestamps: true,
  } as never)) as { text: string; chunks?: { timestamp: [number, number | null]; text: string }[] };
  const dur = audio.length / 16000;
  const chunks = (out.chunks?.length ? out.chunks : [{ timestamp: [0, dur] as [number, number | null], text: out.text }]).map((c) => ({
    start: Math.max(0, c.timestamp[0] ?? 0),
    end: Math.min(dur, c.timestamp[1] ?? dur),
    text: c.text,
  }));
  post({ type: "result", id, chunks });
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") await load(msg);
    else if (msg.type === "run") await run(msg);
  } catch (err) {
    post({ type: "error", id: msg.type === "run" ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
