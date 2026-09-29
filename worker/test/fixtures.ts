/**
 * RSS fixtures.
 *
 * The XML files are ~600 KB of scraped Google News markup and are gitignored,
 * so a fresh clone has none. Rather than commit them (large, and third-party
 * content that rots) the tests fetch them once on demand.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "../src/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "fixtures");

export const FIXTURES: { label: string; domain: string }[] = [
  { label: "akp", domain: "akp.gov.kh" },
  { label: "mef", domain: "mef.gov.kh" },
  { label: "nbc", domain: "nbc.gov.kh" },
  { label: "imf", domain: "imf.org" },
  { label: "asean", domain: "asean.org" },
];

export const fixturePath = (label: string) => join(FIXTURE_DIR, `${label}.xml`);

export function fixturesPresent(): boolean {
  return FIXTURES.every((f) => existsSync(fixturePath(f.label)));
}

/** Download any missing fixture. Returns the labels it actually fetched. */
export async function ensureFixtures(): Promise<string[]> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const fetched: string[] = [];
  for (const { label, domain } of FIXTURES) {
    const target = fixturePath(label);
    if (existsSync(target)) continue;
    const q = encodeURIComponent(`site:${domain} Cambodia`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(target, await res.text(), "utf8");
      fetched.push(label);
    } catch (err) {
      throw new Error(
        `could not download the "${label}" fixture (${domain}): ${(err as Error).message}\n` +
          `  The test suite needs real Google News markup. Run "npm run test:capture" ` +
          `when you have a network connection.`,
      );
    }
  }
  return fetched;
}
