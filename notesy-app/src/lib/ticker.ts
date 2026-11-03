/** Interval driven by a worker: main-thread timers are throttled to once a minute in hidden tabs. */
export function workerInterval(fn: () => void, interval: number) {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./ticker.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = () => fn();
    worker.postMessage({ interval });
    return () => {
      worker?.postMessage({ stop: true });
      worker?.terminate();
    };
  } catch {
    const t = setInterval(fn, interval);
    return () => clearInterval(t);
  }
}
