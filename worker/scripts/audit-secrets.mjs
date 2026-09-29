#!/usr/bin/env node
/**
 * Secret audit: fail if any real credential would be committed.
 *
 * Written because pattern matching is not enough. The only reliable way to know
 * whether a secret is in a file is to compare against the secret's actual value.
 * A generic `api_key = ...` regex finds shapes; it cannot tell a real token from
 * a placeholder, and it missed a real admin token that was pasted into a
 * documentation example.
 *
 * Reads the real values from .env and .dev.vars, then checks every file git
 * would actually stage. Exits non-zero if anything matches.
 *
 *   node worker/scripts/audit-secrets.mjs
 *
 * Git is optional: the ignore rules are applied here rather than shelling out to
 * `git check-ignore`, so this runs on a machine with no git installed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const REPO = join(ROOT, "..");

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  "node_modules", ".wrangler", "dist", ".venv", "venv", "__pycache__",
  ".git", ".pytest_cache", ".mypy_cache", ".idea", ".vscode", "test\\fixtures",
]);
/** Files git is configured to ignore, by name. */
const SKIP_NAMES = new Set([
  ".env", ".dev.vars", "daily.log", ".deps-ok", "Thumbs.db", ".DS_Store",
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else {
      if (SKIP_NAMES.has(entry)) continue;
      if (/\.(log|db|sqlite|sqlite3|pyc)$/.test(entry)) continue;
      yield full;
    }
  }
}

/**
 * Keys whose values are credentials.
 *
 * Filtering by name rather than by value matters: the first version compared
 * every setting and reported APP_URL and DB_PATH as leaks, because those values
 * legitimately appear in documentation and source. They are configuration, not
 * secrets, and flagging them trains you to ignore the output.
 */
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Settings that hold a value but are not credentials. */
const NOT_SECRET =
  /^(PORT|HOST|DB_PATH|APP_URL|CLOUD_WORKER_URL|STREAM_ALERTS|DAILY_DIGEST|DUP_OVERLAP|CLASSIFY_WITH_SUMMARY|PURGE_AFTER_DAYS)$|_?(HOURS|TIMEOUT|SIZE|DELAY|TICK|ITEMS|RESOLVES|BATCH|DAYS)$/;

/** Read `KEY=value` pairs, keeping only credentials long enough to be real. */
function readSecrets(path, minLength = 12) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return new Map(); }
  const out = new Map();
  for (const m of text.matchAll(/^([A-Z_][A-Z0-9_]*)=(.*)$/gm)) {
    const name = m[1];
    const value = m[2].trim();
    // An empty value is worse than useless here: `text.includes("")` is true
    // for every file, which reports the whole repository as a leak.
    if (value.length < minLength) continue;
    if (NOT_SECRET.test(name) || !CREDENTIAL_NAME.test(name)) continue;
    out.set(name, value);
  }
  return out;
}

const secrets = new Map();
for (const [name, value] of readSecrets(join(REPO, ".env"))) secrets.set(`.env:${name}`, value);
for (const [name, value] of readSecrets(join(ROOT, ".dev.vars"))) secrets.set(`.dev.vars:${name}`, value);

if (secrets.size === 0) {
  console.error("No secrets found to compare against. Is .env present?");
  process.exit(2);
}

console.log(`Comparing ${secrets.size} real credential value(s) against every committable file.\n`);

let files = 0;
const leaks = [];
for (const file of walk(REPO)) {
  files++;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const [name, value] of secrets) {
    if (text.includes(value)) leaks.push({ file: relative(REPO, file), name });
  }
}

console.log(`  files scanned : ${files}`);
console.log(`  credentials   : ${secrets.size}`);
console.log(`  leaks         : ${leaks.length}\n`);

if (leaks.length) {
  for (const l of leaks) console.error(`  LEAK  ${l.name}  ->  ${l.file}`);
  console.error(
    "\nRotate the exposed credential, then remove the value. If it was ever pushed," +
      "\nit stays in the history: rewriting is not enough, the secret must be revoked.",
  );
  process.exit(1);
}
console.log("  clean - no real credential is in a committable file.\n");
