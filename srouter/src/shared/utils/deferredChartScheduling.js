// Return a cleanup even when a browser lacks the preferred scheduling API.
// The active guard also protects against callbacks already queued at cleanup.
export function scheduleChartIdle(onReady, host = globalThis) {
  let active = true;
  const run = () => {
    if (!active) return;
    active = false;
    onReady();
  };
  const idle = typeof host.requestIdleCallback === "function";
  const id = idle
    ? host.requestIdleCallback(run, { timeout: 2000 })
    : host.setTimeout(run, 200);
  return () => {
    active = false;
    if (idle) host.cancelIdleCallback?.(id);
    else host.clearTimeout(id);
  };
}

export function observeChartViewport(element, onReady, host = globalThis) {
  // Keep fallback asynchronous, including in StrictMode effect replay.
  if (!element || typeof host.IntersectionObserver !== "function") {
    return scheduleChartIdle(onReady, host);
  }
  let active = true;
  const observer = new host.IntersectionObserver((entries) => {
    if (!active || !entries.some((entry) => entry.target === element && entry.isIntersecting)) return;
    active = false;
    observer.disconnect();
    onReady();
  }, { rootMargin: "0px", threshold: 0 });
  observer.observe(element);
  return () => {
    active = false;
    observer.disconnect();
  };
}
