#!/usr/bin/env node
/**
 * Report the status of Cloudflare Workers Builds runs.
 *
 * Worth having because the GitHub connection is easy to believe is working when
 * it is not: the repo can be pushed, CI can be green, and the Cloudflare-side
 * deploy can still be failing for a reason the dashboard alone will not explain.
 *
 *   node worker/scripts/builds.mjs
 *   node worker/scripts/builds.mjs --json
 *
 * Note what this deliberately does NOT do: change the build settings. Root
 * directory and the deploy command are not exposed by the API, so they have to
 * be set once in the dashboard. That is also why they are not in wrangler.toml.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACCOUNT = "54ed47b486e1a030a544deaaf1e1f9c1";
const SCRIPT = "khmer24news";

function wranglerToken() {
  const path = join(process.env.APPDATA ?? "", "xdg.config/.wrangler/config/default.toml");
  const m = readFileSync(path, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("no wrangler OAuth token found - run: npx wrangler login");
  return m[1];
}

const url =
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}` +
  `/builds/workers/${SCRIPT}/builds`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${wranglerToken()}` } });
const body = await (res.json().catch(() => ({})));
if (!res.ok || !body.success) {
  console.error(`could not read build history: HTTP ${res.status} ${JSON.stringify(body.errors ?? "")}`);
  process.exit(1);
}

const builds = body.result ?? [];
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(builds, null, 2));
  process.exit(0);
}
if (builds.length === 0) {
  console.log("no builds recorded - the GitHub connection has never produced a run");
  process.exit(0);
}

console.log(`Workers Builds history for ${SCRIPT} (${builds.length} run(s))\n`);
for (const b of builds.slice(0, 8)) {
  const at = (b.created_at ?? "").replace("T", " ").slice(0, 19);
  console.log(`  ${at}  ${String(b.status ?? "?").padEnd(9)} ${b.branch ?? "-"}  ${b.commit_msg ?? ""}`);
  if (b.commit_msg) console.log(`  ${" ".repeat(21)}${b.build_uuid}`);
}
const last = builds[0];
console.log(
  `\nlatest: ${last.status}${last.status === "failed" ? " - check the build log in the dashboard" : ""}`,
);
