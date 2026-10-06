import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative, join, sep, isAbsolute } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// Parse only JSON emitted by Next; never execute a manifest as JavaScript.
export function parseClientManifest(source) {
  const match = source.match(/globalThis\.__RSC_MANIFEST\[(("(?:[^"\\]|\\.)*"))\]\s*=\s*([\s\S]*?);?\s*$/);
  if (!match) throw new Error("Unsupported Next client manifest format");
  return { route: JSON.parse(match[1]), manifest: JSON.parse(match[3].replace(/;$/, "")) };
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export function measureChunks(dist) {
  const root = realpathSync(dist);
  // BUILD_ID is present only after a completed production build.
  readFileSync(join(root, "BUILD_ID"), "utf8");
  const build = JSON.parse(readFileSync(join(root, "build-manifest.json"), "utf8"));
  const shared = [...(build.rootMainFiles || []), ...(build.polyfillFiles || [])];
  const cache = new Map();
  const size = (file) => {
    // App Router manifests URL-encode dynamic segments, unlike disk paths.
    try {
      file = decodeURIComponent(file);
    } catch {
      throw new Error("Invalid client chunk path");
    }
    if (!/^static\/.*\.js$/.test(file) || file.includes("..") || file.includes("\\")) {
      throw new Error("Invalid client chunk path");
    }
    const path = realpathSync(join(root, file));
    const inside = relative(root, path);
    if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) throw new Error("Chunk escapes dist");
    if (!cache.has(file)) {
      const bytes = readFileSync(path);
      cache.set(file, { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length });
    }
    return cache.get(file);
  };
  const routes = walk(join(root, "server/app"))
    .filter((file) => file.endsWith("_client-reference-manifest.js"))
    .map((file) => {
      const { route, manifest } = parseClientManifest(readFileSync(file, "utf8"));
      const files = new Set(shared.filter((name) => name.endsWith(".js")));
      for (const clientModule of Object.values(manifest.clientModules || {})) {
        // Webpack's pairs are [chunkID, filename]; ignore chunk IDs.
        for (const chunk of clientModule.chunks || []) {
          if (typeof chunk === "string" && chunk.startsWith("static/") && chunk.endsWith(".js")) files.add(chunk);
        }
      }
      const chunks = [...files].sort().map(size);
      return {
        route, chunks,
        rawBytes: chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0),
        gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
      };
    }).sort((a, b) => a.route.localeCompare(b.route));
  if (!routes.length) throw new Error("No App Router client manifests found");
  return { schema: 1, basis: "manifest-declared-client-js-plus-shared; gzip-level-9; not-network-trace", routes };
}

export function compareChunks(before, after) {
  if (before.schema !== 1 || after.schema !== 1) throw new Error("Unsupported comparison schema");
  const old = new Map(before.routes.map((route) => [route.route, route]));
  return after.routes.map((route) => ({
    route: route.route, rawBytes: route.rawBytes, gzipBytes: route.gzipBytes,
    deltaRawBytes: old.has(route.route) ? route.rawBytes - old.get(route.route).rawBytes : null,
    deltaGzipBytes: old.has(route.route) ? route.gzipBytes - old.get(route.route).gzipBytes : null,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Usage:
  npm run --silent perf:chunks -- <completed-production-dist>
  npm run --silent perf:chunks -- --compare <before.json> <after.json>
Prints JSON only (redirect it to a local file to save); reads dist, no build/server/DB.
Requires webpack App Router client manifests and BUILD_ID. No JS evaluation.
Includes shared runtime/polyfill and deduplicated manifest client JS per route;
excludes CSS, RSC/HTML, lazy chunks not referenced by the manifest, and network cache.
This is a manifest-based initial-dependency estimate, not actual transferred bytes.
gzip level 9 measured per chunk; route keys are build template names, no live URLs.
Compare fresh builds with identical Node/Next/deps/env and gzip settings; report
missing/added routes separately. Removed routes are not emitted by --compare.`);
  } else if (args.length === 3 && args[0] === "--compare") {
    console.log(JSON.stringify(compareChunks(
      JSON.parse(readFileSync(args[1], "utf8")), JSON.parse(readFileSync(args[2], "utf8")),
    ), null, 2));
  } else if (args.length === 1 && !args[0].startsWith("--")) {
    console.log(JSON.stringify(measureChunks(args[0]), null, 2));
  } else {
    throw new Error("Invalid arguments; use --help");
  }
}
