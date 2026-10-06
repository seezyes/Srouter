const fs = require("node:fs");
const path = require("node:path");

// Adapted from pinned VansRouter ad591d72: runtime-only imports need their
// dependency closure even when Next has already created a trace-pruned package.
function resolvePackageDir(pkg, searchPaths) {
  for (const base of searchPaths) {
    const candidate = path.join(base, "node_modules", pkg);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
  }
  try {
    return path.dirname(require.resolve(`${pkg}/package.json`, { paths: searchPaths }));
  } catch {}
  try {
    let directory = path.dirname(require.resolve(pkg, { paths: searchPaths }));
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === pkg) return directory;
      directory = path.dirname(directory);
    }
  } catch {}
  return null;
}

function copyPackageClosure(pkg, { sourceRoots, destinationRoot, copyPackage = (source, destination) => {
  fs.cpSync(source, destination, { recursive: true, force: true, dereference: true });
} }) {
  const queue = [{ name: pkg, searchPaths: sourceRoots }];
  const seen = new Set();
  while (queue.length) {
    const { name, searchPaths } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = resolvePackageDir(name, searchPaths);
    if (!source) throw new Error(`${name} not found while building a runtime dependency closure`);
    const destination = path.join(destinationRoot, name);
    copyPackage(source, destination);
    const manifestPath = path.join(destination, "package.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`${name} was not copied into the runtime closure`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const dependency of Object.keys(manifest.dependencies || {})) {
      queue.push({ name: dependency, searchPaths: [source, path.dirname(source), ...sourceRoots] });
    }
  }
  return [...seen];
}

module.exports = { resolvePackageDir, copyPackageClosure };
