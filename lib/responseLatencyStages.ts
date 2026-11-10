import type { ClientLatencyStages } from "./responseLatencyCore";

export const boundedLatencyMs = (value: number) => Math.max(0, Math.min(3_600_000, Math.round(value)));

/** Per-send numeric observations. No globals or content-bearing labels. */
export function createLatencyStages(initial: ClientLatencyStages = {}, now = () => performance.now()) {
  const timings = { ...initial };
  return {
    timings,
    stage(key: keyof ClientLatencyStages) {
      const started = now();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        timings[key] = boundedLatencyMs((timings[key] ?? 0) + now() - started);
      };
    },
    async measure<T>(key: keyof ClientLatencyStages, work: () => Promise<T>): Promise<T> {
      const stop = this.stage(key);
      try { return await work(); } finally { stop(); }
    },
  };
}
