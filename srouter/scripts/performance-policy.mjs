// The phase, not NODE_ENV alone, prevents profiling in builds and next start.
export function renderProfilingEnabled(phase, env = process.env) {
  return phase === "phase-development-server" && env.SROUTER_RENDER_PROFILE === "1";
}
