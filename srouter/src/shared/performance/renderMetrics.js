// Only a fixed boundary ID, fixed React phase and finite timings are retained.
// No props, route, query, user data, wall clock, storage or network access.
const PHASES = new Set(["mount", "update", "nested-update"]);
export const SAMPLE_LIMIT = 200;

export function createRenderMetrics() {
  let samples = [];
  let enabled = true;
  const record = (_id, phase, actualDuration, baseDuration) => {
    if (!enabled || !PHASES.has(phase) ||
        !Number.isFinite(actualDuration) || actualDuration < 0 ||
        !Number.isFinite(baseDuration) || baseDuration < 0) return;
    if (samples.length === SAMPLE_LIMIT) samples.shift();
    samples.push({ boundary: "Dashboard", phase, actualMs: actualDuration, baseMs: baseDuration });
  };
  return Object.freeze({
    record,
    snapshot: () => samples.map((sample) => ({ ...sample })),
    clear: () => { samples = []; },
    pause: () => { enabled = false; },
    resume: () => { enabled = true; },
    summary: () => {
      const sorted = samples.map((sample) => sample.actualMs).sort((a, b) => a - b);
      const total = sorted.reduce((sum, duration) => sum + duration, 0);
      return {
        boundary: "Dashboard", count: sorted.length,
        totalActualMs: total,
        meanActualMs: sorted.length ? total / sorted.length : 0,
        p95ActualMs: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : 0,
        maxActualMs: sorted.at(-1) || 0,
      };
    },
  });
}
