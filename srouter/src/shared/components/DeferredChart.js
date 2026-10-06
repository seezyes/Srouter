"use client";

import { useEffect, useRef, useState } from "react";
import { observeChartViewport, scheduleChartIdle } from "../utils/deferredChartScheduling";

// Rendering a next/dynamic element only after this gate opens is essential:
// merely declaring a dynamic import does not defer its mount-time download.
export default function DeferredChart({ strategy = "viewport", fallback, children }) {
  const [ready, setReady] = useState(false);
  const target = useRef(null);

  useEffect(() => {
    if (ready) return;
    const reveal = () => setReady(true);
    return strategy === "idle"
      ? scheduleChartIdle(reveal)
      : observeChartViewport(target.current, reveal);
  }, [strategy, ready]);

  return <div ref={target} className="min-w-0">{ready ? children : fallback}</div>;
}
