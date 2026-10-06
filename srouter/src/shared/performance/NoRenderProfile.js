"use client";

// Production resolves directly here; no Profiler, diagnostics, or dynamic import.
export default function NoRenderProfile({ children }) {
  return children;
}
