import { useEffect, useState } from "react";
import { settingsStore } from "../lib/settings";
import { prepareWhisper, whisper } from "../lib/stt";

/**
 * Temporary proof page: loads the configured model and transcribes 4 seconds of a tone, printing each stage.
 * Open at /#/gputest. Remove once the Turbo WebGPU path is proven or rejected.
 */
export function GpuTest() {
  const [lines, setLines] = useState<string[]>(["mulai…"]);
  const add = (s: string) => setLines((prev) => [...prev, `${((performance.now() - t0) / 1000).toFixed(1)}s  ${s}`]);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const s = settingsStore.get();
        add(`model: ${s.whisperModel}, perangkat: ${s.whisperDevice}`);
        await prepareWhisper(s, (loaded, total) => {
          if (stop || !total) return;
          const pct = Math.round((loaded / total) * 100);
          setLines((prev) => {
            const line = `${((performance.now() - t0) / 1000).toFixed(1)}s  unduh ${pct}%`;
            return prev.at(-1)?.includes("unduh") ? [...prev.slice(0, -1), line] : [...prev, line];
          });
        });
        if (stop) return;
        add(`model termuat di ${whisper.device ?? "tidak diketahui"}`);
        const pcm = new Float32Array(16000 * 4);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.2;
        const t = performance.now();
        const chunks = await whisper.run(pcm, "en");
        if (stop) return;
        add(`transkripsi selesai dalam ${((performance.now() - t) / 1000).toFixed(1)}s`);
        add(`hasil: ${JSON.stringify(chunks.map((c) => c.text)).slice(0, 200)}`);
        add(whisper.device === "webgpu" ? "TURBO WEBGPU: JALAN" : `JALAN DI ${whisper.device}, BUKAN WEBGPU`);
      } catch (e) {
        add(`GAGAL: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <pre style={{ padding: 24, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap" }}>
      {lines.join("\n")}
    </pre>
  );
}

const t0 = performance.now();
