// Bridge to the Python reference implementation (dedt_trust), the single source of all keys,
// signatures and proofs used in the tests.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

function python() {
  if (process.env.DEDT_PYTHON) return process.env.DEDT_PYTHON;
  for (const p of [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")]) {
    if (fs.existsSync(p)) return p;
  }
  return process.platform === "win32" ? "python" : "python3";
}

const flag = (k) => "--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/** py("batch", { chainId: 31337, contract, twin: 1, ... }) → parsed JSON */
function py(cmd, args = {}) {
  const argv = ["-m", "dedt_trust.cli", cmd];
  for (const [k, v] of Object.entries(args)) argv.push(flag(k), typeof v === "string" ? v : JSON.stringify(v));
  return JSON.parse(execFileSync(python(), argv, { cwd: ROOT, encoding: "utf8" }));
}

module.exports = { py };
