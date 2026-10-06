"use client";

import { Profiler, useEffect } from "react";
import { createRenderMetrics } from "./renderMetrics";

// Stable callback/collector: recording doesn't set React state or cause commits.
const metrics = createRenderMetrics();
const diagnostics = Object.freeze({
  snapshot: metrics.snapshot, summary: metrics.summary, clear: metrics.clear,
  pause: metrics.pause, resume: metrics.resume,
});

export default function RenderProfileBoundary({ children }) {
  useEffect(() => {
    window.__SROUTER_RENDER_PROFILE__ = diagnostics;
    return () => {
      if (window.__SROUTER_RENDER_PROFILE__ === diagnostics) {
        delete window.__SROUTER_RENDER_PROFILE__;
      }
      metrics.clear();
    };
  }, []);
  return <Profiler id="Dashboard" onRender={metrics.record}>{children}</Profiler>;
}
