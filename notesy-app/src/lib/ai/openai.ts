import { ensureHostPermission } from "../platform";
import type { PromptImage } from "./cursor";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  text: string;
  images?: PromptImage[];
}

export async function openaiChat(
  base: string,
  key: string,
  model: string,
  turns: ChatTurn[],
  onDelta?: (full: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  await ensureHostPermission(url);
  const messages = turns.map((t) =>
    t.images?.length
      ? {
          role: t.role,
          content: [
            { type: "text", text: t.text },
            ...t.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
          ],
        }
      : { role: t.role, content: t.text },
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.3 }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(full);
        }
      } catch {
        /* keep-alive or partial line */
      }
    }
  }
  return full;
}
