import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadBindings, transform } from "next/dist/build/swc/index.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { observeChartViewport, scheduleChartIdle } from "../../src/shared/utils/deferredChartScheduling.js";
import { USAGE_CHART_LAYOUT } from "../../src/shared/constants/usageChartLayout.js";

// SWC matches the existing SSR tests; no DOM/test-renderer dependency required.
async function compile(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { code } = await transform(readFileSync(file, "utf8"), {
    filename: file.pathname,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const compiled = { exports: {} };
  new Function("module", "exports", "require", code)(compiled, compiled.exports, (id) => {
    if (!(id in imports)) throw new Error(`Unexpected import: ${id}`);
    const dependency = imports[id];
    return "default" in dependency ? { ...dependency, __esModule: true } : dependency;
  });
  return compiled.exports.default;
}

function observerHost() {
  const instances = [];
  class IntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observe = vi.fn();
      this.disconnect = vi.fn();
      instances.push(this);
    }
  }
  return { IntersectionObserver, instances };
}

beforeAll(() => loadBindings());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chart scheduling browser contracts", () => {
  it("waits for idle and runs once, with bounded starvation timeout", () => {
    const ready = vi.fn();
    let callback;
    const host = {
      requestIdleCallback: vi.fn((fn) => { callback = fn; return 12; }),
      cancelIdleCallback: vi.fn(),
    };
    const cancel = scheduleChartIdle(ready, host);
    expect(ready).not.toHaveBeenCalled();
    expect(host.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });
    callback();
    callback();
    expect(ready).toHaveBeenCalledTimes(1);
    cancel();
    expect(host.cancelIdleCallback).toHaveBeenCalledWith(12);
  });

  it("blocks stale idle callbacks after cleanup even without cancelIdleCallback", () => {
    let callback;
    const ready = vi.fn();
    const cancel = scheduleChartIdle(ready, { requestIdleCallback: (fn) => { callback = fn; } });
    cancel();
    callback();
    expect(ready).not.toHaveBeenCalled();
  });

  it("uses a cancellable 200ms timer when idle API is absent", () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const cancel = scheduleChartIdle(ready, { setTimeout, clearTimeout });
    vi.advanceTimersByTime(199);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ready).toHaveBeenCalledTimes(1);
    cancel();
    const cancelled = vi.fn();
    scheduleChartIdle(cancelled, { setTimeout, clearTimeout })();
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("waits for its own visible target, disconnecting after the first intersection", () => {
    const host = observerHost();
    const target = {};
    const ready = vi.fn();
    const cancel = observeChartViewport(target, ready, host);
    const observer = host.instances[0];
    expect(observer.observe).toHaveBeenCalledWith(target);
    expect(observer.options).toEqual({ rootMargin: "0px", threshold: 0 });
    observer.callback([{ target, isIntersecting: false }]);
    observer.callback([{ target: {}, isIntersecting: true }]);
    expect(ready).not.toHaveBeenCalled();
    observer.callback([{ target, isIntersecting: true }]);
    observer.callback([{ target, isIntersecting: true }]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("disconnects and ignores queued observer deliveries after unmount", () => {
    const host = observerHost();
    const target = {};
    const ready = vi.fn();
    observeChartViewport(target, ready, host)();
    const observer = host.instances[0];
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    observer.callback([{ target, isIntersecting: true }]);
    expect(ready).not.toHaveBeenCalled();
  });

  it.each([null, {}])("falls back asynchronously for missing target/API (%j)", (target) => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const cancel = observeChartViewport(target, ready, { setTimeout, clearTimeout });
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(ready).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("replays setup/cleanup/setup independently like StrictMode without stale activation", () => {
    const host = observerHost();
    const target = {};
    const ready = vi.fn();
    observeChartViewport(target, ready, host)();
    const secondCleanup = observeChartViewport(target, ready, host);
    host.instances[0].callback([{ target, isIntersecting: true }]);
    expect(ready).not.toHaveBeenCalled();
    host.instances[1].callback([{ target, isIntersecting: true }]);
    expect(ready).toHaveBeenCalledTimes(1);
    secondCleanup();
    expect(host.instances.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });
});

describe("DeferredChart component lifecycle", () => {
  // Execute the actual component/effect with a tiny deterministic hooks host;
  // React SSR then reconciles its output, so mounted child spies really render.
  async function harness() {
    let ready = false;
    let effect;
    const ref = { current: {} };
    const hooks = {
      useState: () => [ready, (value) => { ready = value; }],
      useRef: () => ref,
      useEffect: (fn) => { effect = fn; },
    };
    const Component = await compile("../../src/shared/components/DeferredChart.js", {
      react: hooks,
      "react/jsx-runtime": jsxRuntime,
      "../utils/deferredChartScheduling": { observeChartViewport, scheduleChartIdle },
    });
    return {
      render: (props) => renderToStaticMarkup(Component(props)),
      setup: () => effect(),
      ready: () => ready,
      target: ref.current,
    };
  }

  it("does not mount dynamic children until viewport activation; uses latest props afterward", async () => {
    const host = observerHost();
    vi.stubGlobal("IntersectionObserver", host.IntersectionObserver);
    const h = await harness();
    const child = vi.fn(({ period }) => React.createElement("span", null, period));
    const props = (period) => ({
      fallback: React.createElement("span", null, "skeleton"),
      children: React.createElement(child, { period }),
    });
    expect(h.render(props("today"))).toContain("skeleton");
    const cleanup = h.setup();
    expect(h.render(props("30d"))).toContain("skeleton");
    expect(child).not.toHaveBeenCalled();
    host.instances[0].callback([{ target: h.target, isIntersecting: true }]);
    expect(h.render(props("30d"))).toContain("30d");
    expect(child).toHaveBeenCalledTimes(1);
    cleanup();
    expect(h.setup()).toBeUndefined(); // A ready chart never reschedules.
  });

  it("keeps idle children unmounted through effect replay and cancelled callbacks", async () => {
    const callbacks = [];
    vi.stubGlobal("requestIdleCallback", (fn) => { callbacks.push(fn); return callbacks.length; });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const h = await harness();
    const child = vi.fn(() => React.createElement("span", null, "topology"));
    const props = { strategy: "idle", fallback: "skeleton", children: React.createElement(child) };
    h.render(props);
    h.setup()();
    const cleanup = h.setup();
    callbacks[0]();
    expect(h.ready()).toBe(false);
    expect(h.render(props)).toContain("skeleton");
    expect(child).not.toHaveBeenCalled();
    callbacks[1]();
    expect(h.render(props)).toContain("topology");
    expect(child).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("renders the skeleton on actual React server rendering without browser globals", async () => {
    const Component = await compile("../../src/shared/components/DeferredChart.js", {
      react: React, "react/jsx-runtime": jsxRuntime,
      "../utils/deferredChartScheduling": { observeChartViewport, scheduleChartIdle },
    });
    const child = vi.fn(() => "chart");
    const html = renderToStaticMarkup(React.createElement(Component, {
      fallback: "skeleton",
    }, React.createElement(child)));
    expect(html).toContain("skeleton");
    expect(child).not.toHaveBeenCalled();
  });
});

describe("UsageStats chart integration", () => {
  it("puts all four dynamic chunks behind the correct gates without changing their input data", async () => {
    const Gate = await compile("../../src/shared/components/DeferredChart.js", {
      react: React, "react/jsx-runtime": jsxRuntime,
      "../utils/deferredChartScheduling": { observeChartViewport, scheduleChartIdle },
    });
    const gates = [];
    const dynamics = [];
    const mounted = vi.fn(() => "chart");
    const stats = {
      byProvider: { test: { requests: 2 } }, byModel: {},
      activeRequests: [{ provider: "test" }],
      recentRequests: [{ provider: "test", model: "m", timestamp: new Date().toISOString() }],
      errorProvider: "error",
    };
    const providers = [{ provider: "test" }];
    const values = [stats, false, false, "model", "costs", providers, "today"];
    let stateIndex = 0;
    const hooks = {
      useState: () => [values[stateIndex++], vi.fn()],
      useRef: (value) => ({ current: value }),
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    };
    const base = "@/app/(dashboard)/dashboard/usage/components/";
    const Component = await compile("../../src/shared/components/UsageStats.js", {
      react: hooks, "react/jsx-runtime": jsxRuntime,
      "next/navigation": { useRouter: () => ({}), useSearchParams: () => new URLSearchParams() },
      "@/shared/constants/providers": { FREE_PROVIDERS: {}, AI_PROVIDERS: {} },
      "./Badge": { default: () => null },
      "./Card": { default: ({ children }) => React.createElement("div", null, children) },
      [base + "OverviewCards"]: { default: () => null },
      [base + "UsageTable"]: { default: () => null, fmt: String, fmtTime: String },
      "next/dynamic": { default: (loader, options) => { dynamics.push({ loader, options }); return mounted; } },
      "./DeferredChart": { default: (props) => { gates.push(props); return React.createElement(Gate, props); } },
      "./UsageChartSkeleton": { default: ({ kind = "usage" }) => React.createElement("span", null, `skeleton-${kind}`) },
    });
    const html = renderToStaticMarkup(Component({ period: "30d", hidePeriodSelector: true }));
    expect(dynamics).toHaveLength(4);
    expect(dynamics.every(({ options }) => options.ssr === false)).toBe(true);
    expect(gates).toHaveLength(4);
    expect(gates.map(({ strategy = "viewport" }) => strategy)).toEqual(["idle", "viewport", "viewport", "viewport"]);
    expect(mounted).not.toHaveBeenCalled();
    expect(gates[0].children.props).toEqual({
      providers, activeRequests: stats.activeRequests, lastProvider: "test", errorProvider: "error",
    });
    expect(gates[1].children.props.period).toBe("30d");
    expect(gates[2].children.props.byProvider).toBe(stats.byProvider);
    expect(gates[3].children.props.byModel).toBe(stats.byModel);
    for (const [i, kind] of ["topology", "usage", "provider", "models"].entries()) {
      expect(html).toContain(`skeleton-${kind}`);
      expect(renderToStaticMarkup(React.createElement(dynamics[i].options.loading))).toContain(`skeleton-${kind}`);
    }
    expect(html).toContain("Recent Requests");
    expect(html).toContain("Usage by Model");
    expect(html).toContain("Costs");
    expect(html).toContain("Tokens");
    values[0] = null;
    values[1] = true;
    stateIndex = 0;
    gates.length = 0;
    const initial = renderToStaticMarkup(Component({ hidePeriodSelector: true }));
    for (const kind of ["topology", "requests", "usage", "provider", "models"]) {
      expect(initial).toContain(`skeleton-${kind}`);
    }
    expect(gates).toHaveLength(0); // Stats loading does not start chart scheduling.
    expect(mounted).not.toHaveBeenCalled();
  });
});

describe("placeholder geometry matches all chart states", () => {
  const card = ({ children, className, padding, ...props }) => React.createElement("div", { ...props, className }, children);
  const recharts = {
    ResponsiveContainer: ({ height }) => React.createElement("div", { style: { height } }),
  };
  for (const name of ["AreaChart", "Area", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "BarChart", "Bar", "Cell"]) {
    recharts[name] = () => null;
  }
  const common = {
    react: React, "react/jsx-runtime": jsxRuntime,
    "prop-types": { default: { string: null, object: null } },
    "@/shared/components/Card": { default: card },
    "@/shared/constants/usageChartLayout": { USAGE_CHART_LAYOUT },
    recharts,
  };

  it.each([
    ["usage", "UsageChart", {}],
    ["provider", "ProviderBarChart", { byProvider: { test: { promptTokens: 100 } } }],
    ["models", "TopModelsChart", { byModel: { test: { rawModel: "test", promptTokens: 100 } } }],
  ])("%s preserves shell/header/body sizes for skeleton, loading/empty and data", async (kind, module, dataProps) => {
    const Skeleton = await compile("../../src/shared/components/UsageChartSkeleton.js", {
      "react/jsx-runtime": jsxRuntime,
      "./Card": { default: card },
      "../constants/usageChartLayout": { USAGE_CHART_LAYOUT },
    });
    const Chart = await compile(`../../src/app/(dashboard)/dashboard/usage/components/${module}.js`, common);
    const layout = USAGE_CHART_LAYOUT[kind];
    const skeleton = renderToStaticMarkup(React.createElement(Skeleton, { kind }));
    const initial = renderToStaticMarkup(React.createElement(Chart));
    const populated = renderToStaticMarkup(React.createElement(Chart, dataProps));
    const states = [skeleton, initial, populated];
    if (kind === "usage") {
      // UsageChart owns fetched data rather than receiving it through props.
      for (const data of [[], [{ tokens: 100, label: "today" }]]) {
        let index = 0;
        const values = [data, false, "tokens"];
        const LoadedChart = await compile(`../../src/app/(dashboard)/dashboard/usage/components/${module}.js`, {
          ...common,
          react: {
            useState: () => [values[index++], vi.fn()],
            useEffect: () => {},
            useCallback: (fn) => fn,
          },
        });
        const html = renderToStaticMarkup(LoadedChart({ period: "today" }));
        expect(html).not.toContain("Loading...");
        expect(html.includes("No data for this period")).toBe(data.length === 0);
        states.push(html);
      }
    }
    for (const html of states) {
      expect(html).toContain(USAGE_CHART_LAYOUT.cardClassName);
      expect(html).toContain(`height:${layout.headerHeight}px`);
      expect(html).toContain(`height:${layout.bodyHeight}px`);
    }
    expect(skeleton).toContain('aria-hidden="true"');
  });

  it("topology keeps its existing 320px/mobile and 480px/sm dimensions", async () => {
    const Skeleton = await compile("../../src/shared/components/UsageChartSkeleton.js", {
      "react/jsx-runtime": jsxRuntime,
      "./Card": { default: card },
      "../constants/usageChartLayout": { USAGE_CHART_LAYOUT },
    });
    const html = renderToStaticMarkup(React.createElement(Skeleton, { kind: "topology" }));
    expect(html).toContain("h-[320px]");
    expect(html).toContain("sm:h-[480px]");
  });
});
