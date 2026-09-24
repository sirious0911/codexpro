import fs from "node:fs";
import path from "node:path";

function isRegularFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
}

export function npmCliCandidates({
  env = process.env,
  nodeExecPath = process.execPath,
  platform = process.platform
} = {}) {
  const nodeDir = path.dirname(nodeExecPath);
  const candidates = [
    env.npm_execpath,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ];

  if (platform !== "win32") {
    candidates.push(
      path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(nodeDir, "..", "share", "node_modules", "npm", "bin", "npm-cli.js")
    );
  }

  return unique(candidates);
}

export function resolveNpmCli(options = {}) {
  const candidates = npmCliCandidates(options);
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    if (isRegularFile(candidate)) return candidate;
  }
  throw new Error(
    `Unable to locate npm-cli.js for shell-free npm invocation. Checked: ${candidates.join(", ") || "(none)"}`
  );
}

export function resolveNpmInvocation(args, options = {}) {
  if (!Array.isArray(args)) throw new Error("npm args must be an array");
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  return {
    command: nodeExecPath,
    args: [resolveNpmCli({ ...options, nodeExecPath }), ...args]
  };
}
