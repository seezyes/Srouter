const fs = require("fs");
const { execFileSync } = require("child_process");

// Stream the archive through stdin: GNU tar interprets Windows drive letters
// in archive filenames as remote tape hosts. cwd also avoids -C path parsing.
function readTarball(tarball, args, options = {}) {
  return execFileSync("tar", [args[0], "-f", "-", ...args.slice(1)], {
    ...options,
    input: fs.readFileSync(tarball),
  });
}

function extractTarball(tarball, directory) {
  readTarball(tarball, ["-xz"], { cwd: directory });
}

module.exports = { readTarball, extractTarball };
