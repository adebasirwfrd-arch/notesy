import { TARGET, apiUrl } from "../platform";
import { sleep } from "../util";

const BASE = "https://api.cursor.com";

export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface CursorModel {
  id: string;
  displayName: string;
  description?: string;
}

export interface RunResult {
  agentId: string;
  runId: string;
  text: string;
}

const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

export class CursorApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Anything that is not a Cursor key is a passcode for the hosted proxy, which holds the real key server-side. */
export const isCursorKey = (v: string) => /^(crsr_|key_)/.test(v.trim());

export class CursorClient {
  constructor(private apiKey: string) {}

  private headers(extra: Record<string, string> = {}) {
    const auth: Record<string, string> = isCursorKey(this.apiKey)
      ? { Authorization: `Basic ${btoa(`${this.apiKey}:`)}` }
      : { "X-Notesy-Pass": this.apiKey };
    return { ...auth, ...extra };
  }

  /** The Android WebView origin is rejected by Cursor's CORS policy, so requests go through the native HTTP stack there. */
  private async send(method: string, url: string, headers: Record<string, string>, body?: string, signal?: AbortSignal) {
    if (TARGET === "android") {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { CapacitorHttp } = await import("@capacitor/core");
      const r = await CapacitorHttp.request({ method, url, headers, data: body, responseType: "text" });
      const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
      return { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: "", text };
    }
    const res = await fetch(apiUrl(url), { method, headers, body, signal });
    return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text() };
  }

  private async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.send(
      method,
      BASE + path,
      this.headers(body ? { "Content-Type": "application/json" } : {}),
      body ? JSON.stringify(body) : undefined,
      signal,
    );
    const text = res.text;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string; code?: string }; message?: string; code?: string } | null) ?? {};
      const msg = err.error?.message ?? err.message ?? text.slice(0, 300) ?? res.statusText;
      throw new CursorApiError(res.status, explain(res.status, msg), err.error?.code ?? err.code);
    }
    return json as T;
  }

  me() {
    return this.req<{ apiKeyName: string; userEmail?: string; userFirstName?: string }>("GET", "/v1/me");
  }

  async models(): Promise<CursorModel[]> {
    const r = await this.req<{ items?: CursorModel[] }>("GET", "/v1/models");
    return r.items ?? [];
  }

  async createAgent(text: string, opts: { images?: PromptImage[]; model?: string; name?: string; signal?: AbortSignal }) {
    const r = await this.req<{ agent: { id: string }; run: { id: string } }>(
      "POST",
      "/v1/agents",
      {
        prompt: { text, ...(opts.images?.length ? { images: opts.images } : {}) },
        ...(opts.model ? { model: { id: opts.model } } : {}),
        ...(opts.name ? { name: opts.name.slice(0, 100) } : {}),
      },
      opts.signal,
    );
    return { agentId: r.agent.id, runId: r.run.id };
  }

  async followUp(agentId: string, text: string, opts: { images?: PromptImage[]; signal?: AbortSignal } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.req<{ run: { id: string } }>(
          "POST",
          `/v1/agents/${agentId}/runs`,
          { prompt: { text, ...(opts.images?.length ? { images: opts.images } : {}) } },
          opts.signal,
        );
        return { agentId, runId: r.run.id };
      } catch (e) {
        if (e instanceof CursorApiError && e.status === 409 && attempt < 30) {
          await sleep(3000);
          continue;
        }
        throw e;
      }
    }
  }

  getRun(agentId: string, runId: string) {
    return this.req<{ status: string; result?: string }>("GET", `/v1/agents/${agentId}/runs/${runId}`);
  }

  cancel(agentId: string, runId: string) {
    return this.req("POST", `/v1/agents/${agentId}/runs/${runId}/cancel`).catch(() => {});
  }

  archive(agentId: string) {
    return this.req("POST", `/v1/agents/${agentId}/archive`).catch(() => {});
  }

  /** Streams assistant text; falls back to polling when the stream is unavailable or buffered. */
  async wait(agentId: string, runId: string, onDelta?: (full: string) => void, signal?: AbortSignal): Promise<RunResult> {
    let streamed = "";
    try {
      if (TARGET === "android") throw new Error("no browser stream on android");
      const res = await fetch(apiUrl(`${BASE}/v1/agents/${agentId}/runs/${runId}/stream`), {
        headers: this.headers({ Accept: "text/event-stream" }),
        signal,
      });
      if (res.ok && res.body) {
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        let final: string | undefined;
        let failed: string | undefined;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "message";
            let data = "";
            for (const line of raw.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            let payload: { text?: string; status?: string; message?: string } = {};
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            if (event === "assistant" && payload.text) {
              streamed += payload.text;
              onDelta?.(streamed);
            } else if (event === "result") {
              if (payload.status && payload.status !== "FINISHED") failed = payload.status;
              final = payload.text ?? streamed;
            } else if (event === "error") {
              failed = payload.message ?? "stream error";
            }
          }
        }
        if (failed) throw new Error(`Agent Cursor berhenti: ${failed}`);
        if (final !== undefined) return { agentId, runId, text: final };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof Error && e.message.startsWith("Agent Cursor berhenti")) throw e;
    }
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const run = await this.getRun(agentId, runId);
      if (TERMINAL.has(run.status)) {
        if (run.status !== "FINISHED") throw new Error(`Agent Cursor berhenti: ${run.status}`);
        onDelta?.(run.result ?? streamed);
        return { agentId, runId, text: run.result ?? streamed };
      }
      await sleep(i < 10 ? 1500 : 3000);
    }
  }
}

function explain(status: number, msg: string) {
  if (status === 401) return "API key Cursor tidak valid atau sudah dicabut. Buat key baru di cursor.com/dashboard → Integrations.";
  if (status === 403) return `Akses ditolak oleh Cursor: ${msg}`;
  if (status === 429) return "Batas pemakaian Cursor tercapai. Coba lagi beberapa saat lagi.";
  return `Cursor API ${status}: ${msg}`;
}
