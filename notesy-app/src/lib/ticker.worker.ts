let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<{ interval?: number; stop?: boolean }>) => {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (e.data.stop) return;
  timer = setInterval(() => (self as unknown as Worker).postMessage(Date.now()), e.data.interval ?? 1000);
};
