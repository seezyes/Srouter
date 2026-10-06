import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createRenderMetrics, SAMPLE_LIMIT } from "../../src/shared/performance/renderMetrics.js";
import { renderProfilingEnabled } from "../../scripts/performance-policy.mjs";
import { measureChunks, parseClientManifest, compareChunks } from "../../scripts/performance-chunks.mjs";
import configureNext from "../../next.config.mjs";

const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("explicit source render profiling", () => {
  it("requires the exact opt-in and development-server phase", () => {
    expect(renderProfilingEnabled("phase-development-server", { NODE_ENV: "development" })).toBe(false);
    expect(renderProfilingEnabled("phase-development-server", { SROUTER_RENDER_PROFILE: "true" })).toBe(false);
    expect(renderProfilingEnabled("phase-development-server", { SROUTER_RENDER_PROFILE: "1" })).toBe(true);
  });

  it.each(["phase-production-build", "phase-production-server", "phase-export"])(
    "resolves the import to an inert module in %s even with opt-in", async (phase) => {
      vi.stubEnv("SROUTER_RENDER_PROFILE", "1");
      vi.stubEnv("SROUTER_BUNDLE_ANALYZE", "0");
      const config = await configureNext(phase);
      const webpack = config.webpack({ resolve: {} }, { isServer: true });
      expect(webpack.resolve.alias["srouter-render-profile"]).toMatch(/NoRenderProfile\.js$/);
      expect(config.turbopack.resolveAlias["srouter-render-profile"]).toMatch(/NoRenderProfile\.js$/);
      const stub = readFileSync(webpack.resolve.alias["srouter-render-profile"], "utf8");
      expect(stub).not.toMatch(/^\s*import\s/m);
      expect(stub).not.toContain("__SROUTER_RENDER_PROFILE__");
    },
  );

  it("selects runtime only for opted-in dev and preserves webpack behavior", async () => {
    vi.stubEnv("SROUTER_RENDER_PROFILE", "1");
    const config = await configureNext("phase-development-server");
    const webpack = config.webpack({ resolve: { alias: { existing: "kept" } } }, { isServer: false });
    expect(webpack.resolve.alias["srouter-render-profile"]).toMatch(/RenderProfileBoundary\.js$/);
    expect(webpack.resolve.alias.existing).toBe("kept");
    expect(webpack.resolve.fallback.fs).toBe(false);
    expect(config.distDir).toBe(process.env.NEXT_DIST_DIR || ".next");
  });

  it("does not activate diagnostics in ordinary dev", async () => {
    vi.stubEnv("SROUTER_RENDER_PROFILE", "0");
    const config = await configureNext("phase-development-server");
    expect(config.turbopack.resolveAlias["srouter-render-profile"]).toContain("NoRenderProfile");
  });

  it("uses an isolated TS config only for explicit analysis builds", async () => {
    vi.stubEnv("SROUTER_ANALYZE_TSCONFIG", ".next-analyze-fixture.tsconfig.json");
    vi.stubEnv("SROUTER_BUNDLE_ANALYZE", "1");
    const analysis = await configureNext("phase-production-build");
    expect(analysis.typescript.tsconfigPath).toBe(".next-analyze-fixture.tsconfig.json");
    const dev = await configureNext("phase-development-server");
    expect(dev.typescript).toBeUndefined();
    vi.stubEnv("SROUTER_BUNDLE_ANALYZE", "0");
    const ordinary = await configureNext("phase-production-build");
    expect(ordinary.typescript).toBeUndefined();
  });

  it("bounds samples and does not retain supplied IDs or extra content", () => {
    const metrics = createRenderMetrics();
    for (let index = 0; index < SAMPLE_LIMIT + 3; index++) {
      metrics.record("https://private/?token=secret", "update", index, 10, "secret");
    }
    expect(metrics.snapshot()).toHaveLength(SAMPLE_LIMIT);
    expect(metrics.snapshot()[0].actualMs).toBe(3);
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/secret|https|token/);
    expect(metrics.summary().count).toBe(SAMPLE_LIMIT);
    expect(metrics.summary().maxActualMs).toBe(SAMPLE_LIMIT + 2);
  });

  it("rejects invalid phases and nonfinite/negative timings", () => {
    const metrics = createRenderMetrics();
    metrics.record("Dashboard", "credentials", 1, 1);
    metrics.record("Dashboard", "update", NaN, 1);
    metrics.record("Dashboard", "mount", 1, Infinity);
    metrics.record("Dashboard", "nested-update", -1, 1);
    expect(metrics.snapshot()).toEqual([]);
  });

  it("supports summaries, clear, pause/resume and detached snapshots", () => {
    const metrics = createRenderMetrics();
    metrics.record("", "mount", 2, 10);
    metrics.record("", "update", 8, 10);
    expect(metrics.summary()).toMatchObject({ meanActualMs: 5, p95ActualMs: 8, totalActualMs: 10 });
    metrics.snapshot()[0].actualMs = 999;
    expect(metrics.snapshot()[0].actualMs).toBe(2);
    metrics.pause();
    metrics.record("", "update", 30, 30);
    expect(metrics.snapshot()).toHaveLength(2);
    metrics.resume();
    metrics.record("", "update", 30, 30);
    expect(metrics.snapshot()).toHaveLength(3);
    metrics.clear();
    expect(metrics.summary()).toMatchObject({ count: 0, meanActualMs: 0, p95ActualMs: 0 });
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "srouter-perf-tools-test-"));
  temporary.push(directory);
  mkdirSync(join(directory, "server/app/dashboard"), { recursive: true });
  mkdirSync(join(directory, "static/chunks"), { recursive: true });
  writeFileSync(join(directory, "BUILD_ID"), "fixture");
  writeFileSync(join(directory, "build-manifest.json"), JSON.stringify({
    rootMainFiles: ["static/chunks/runtime.js"], polyfillFiles: [],
  }));
  writeFileSync(join(directory, "static/chunks/runtime.js"), "runtime".repeat(100));
  writeFileSync(join(directory, "static/chunks/page.js"), "page".repeat(100));
  const manifest = { clientModules: {
    a: { chunks: ["1", "static/chunks/page.js"] },
    b: { chunks: ["1", "static/chunks/page.js", "2", "static/chunks/runtime.js"] },
  } };
  const clientPath = join(directory, "server/app/dashboard/page_client-reference-manifest.js");
  writeFileSync(clientPath, `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify(manifest)};`);
  return { directory, clientPath };
}

describe("offline source production chunk measurement", () => {
  it("parses Next JSON without evaluating JS", () => {
    expect(parseClientManifest('globalThis.__RSC_MANIFEST["/x/page"]={"clientModules":{}};').route).toBe("/x/page");
    expect(() => parseClientManifest('globalThis.__RSC_MANIFEST["/x"]=process.exit(1);')).toThrow();
    expect(() => parseClientManifest('alert("unsafe")')).toThrow();
  });

  it("deduplicates shared and route chunks and calculates per-file gzip", () => {
    const { directory } = fixture();
    const result = measureChunks(directory);
    const route = result.routes[0];
    expect(route.route).toBe("/dashboard/page");
    expect(route.chunks).toHaveLength(2);
    expect(route.rawBytes).toBe(1100);
    expect(route.gzipBytes).toBe(
      gzipSync(Buffer.from("runtime".repeat(100)), { level: 9 }).length +
      gzipSync(Buffer.from("page".repeat(100)), { level: 9 }).length,
    );
    expect(JSON.stringify(result)).not.toContain(directory);
  });

  it("rejects traversal in declared chunk names", () => {
    const { directory, clientPath } = fixture();
    writeFileSync(clientPath, 'globalThis.__RSC_MANIFEST["/x"]={"clientModules":{"a":{"chunks":["static/../secret.js"]}}};');
    expect(() => measureChunks(directory)).toThrow("Invalid client chunk path");
  });

  it("resolves URL-encoded App Router dynamic segments to disk paths", () => {
    const { directory, clientPath } = fixture();
    mkdirSync(join(directory, "static/chunks/[id]"));
    writeFileSync(join(directory, "static/chunks/[id]/page.js"), "dynamic");
    writeFileSync(clientPath, 'globalThis.__RSC_MANIFEST["/x/[id]/page"]={"clientModules":{"a":{"chunks":["static/chunks/%5Bid%5D/page.js"]}}};');
    const result = measureChunks(directory);
    expect(result.routes[0].chunks.map((chunk) => chunk.file)).toContain("static/chunks/[id]/page.js");
  });

  it.each(["static/%2e%2e/secret.js", "static/%5csecret.js", "static/%zz.js"])(
    "rejects invalid encoded chunk paths: %s", (chunk) => {
      const { directory, clientPath } = fixture();
      writeFileSync(clientPath, `globalThis.__RSC_MANIFEST["/x"]=${JSON.stringify({
        clientModules: { a: { chunks: [chunk] } },
      })};`);
      expect(() => measureChunks(directory)).toThrow("Invalid client chunk path");
    },
  );

  it("compares matching template routes independently of chunk hashes", () => {
    const before = { schema: 1, routes: [{ route: "/x/page", rawBytes: 100, gzipBytes: 80 }] };
    const after = { schema: 1, routes: [
      { route: "/x/page", rawBytes: 90, gzipBytes: 60 },
      { route: "/new/page", rawBytes: 20, gzipBytes: 10 },
    ] };
    expect(compareChunks(before, after)[0]).toMatchObject({ deltaRawBytes: -10, deltaGzipBytes: -20 });
    expect(compareChunks(before, after)[1].deltaRawBytes).toBeNull();
  });

  it("analysis wrapper uses isolated builds and no postbuild/server", () => {
    const source = readFileSync(new URL("../../scripts/performance-build.mjs", import.meta.url), "utf8");
    expect(source).toContain("randomUUID()");
    expect(source).toContain('mkdtempSync(join(tmpdir(), "srouter-bundle-analysis-"))');
    expect(source).toContain('"build", "--webpack"');
    expect(source).toContain('SROUTER_RENDER_PROFILE: "0"');
    expect(source).toContain('SROUTER_DEV_AUTHORITATIVE_DB: ""');
    expect(source).toContain('SROUTER_ANALYZE_TSCONFIG: tsconfig');
    expect(source).toContain('copyFileSync(join(root, "tsconfig.json"), join(root, tsconfig))');
    expect(source).not.toMatch(/"start"|"dev"|"postbuild"/);
  });
});
