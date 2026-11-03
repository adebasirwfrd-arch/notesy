import { Tensor, env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

type LoadMsg = { type: "load"; model: string; device: "webgpu" | "wasm"; ortBase: string };
type RunMsg = { type: "run"; id: number; audio: Float32Array; language: string | null };
type DetectMsg = { type: "detect"; id: number; audio: Float32Array; candidates: string[] };
type InMsg = LoadMsg | RunMsg | DetectMsg;

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

/**
 * transformers.js silently forces English when no language is given, which makes Whisper translate.
 * Score the language tokens Whisper predicts right after start-of-transcript instead.
 */
async function detect({ id, audio, candidates }: DetectMsg) {
  if (!asr) throw new Error("model not loaded");
  const model = asr.model as unknown as {
    generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
    (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
  };
  const { input_features } = (await asr.processor(audio)) as { input_features: unknown };
  const sot = model.generation_config.decoder_start_token_id;
  const out = await model({ input_features, decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const vocab = out.logits.dims.at(-1)!;
  const last = out.logits.data.slice(out.logits.data.length - vocab);
  const scores: Record<string, number> = {};
  for (const code of candidates) {
    const tokenId = model.generation_config.lang_to_id[`<|${code === "jv" ? "jw" : code}|>`];
    if (tokenId !== undefined) scores[code] = last[tokenId];
  }
  post({ type: "detected", id, scores });
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") await load(msg);
    else if (msg.type === "run") await run(msg);
    else if (msg.type === "detect") await detect(msg);
  } catch (err) {
    post({ type: "error", id: msg.type === "load" ? undefined : msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
