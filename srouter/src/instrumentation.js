// Next.js instrumentation hook — runs on server startup (Node.js runtime only).
// Also reactivates Kimchi provider connections whose monthly quota cooldown has
// passed, and re-checks hourly so a process running across a month boundary
// still picks up the reset.

const REACTIVATION_INTERVAL_MS = 3600_000; // 1 hour

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    const { initializeHostedSearchPlugins } = await import("@/lib/hostedSearch/plugins.js");
    const { HOSTED_SEARCH_PLUGIN_DIR } = await import("@/lib/hostedSearch/registry.js");
    await initializeHostedSearchPlugins(HOSTED_SEARCH_PLUGIN_DIR);

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }

  // Skip in development: `next dev` runs instrumentation through webpack, while
  // the Node-only DB layer behind the webpackIgnore'd import in
  // kimchiQuotaReactivation.js is meant to be resolved at runtime by the
  // standalone/production server.
  if (process.env.NODE_ENV === "development") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reactivateExpiredKimchiAccounts } = await import(
    "./sse/services/kimchiQuotaReactivation.js"
  );

  // Run once immediately on startup. Errors are swallowed so a failing DB
  // (e.g. not yet initialized) does not crash the server boot.
  reactivateExpiredKimchiAccounts().catch((e) => {
    // Use console to avoid coupling to the logger which may not be ready yet.
    console.warn("[instrumentation] Kimchi quota reactivation on startup failed:", e?.message || e);
  });

  // Re-check every hour. `.unref?.()` so the timer does not keep the process alive.
  const timer = setInterval(() => {
    reactivateExpiredKimchiAccounts().catch((e) => {
      console.warn("[instrumentation] Kimchi quota reactivation tick failed:", e?.message || e);
    });
  }, REACTIVATION_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
