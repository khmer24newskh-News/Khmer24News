/** Re-record the RSS fixtures. Run: npm run test:capture */
import { ensureFixtures, FIXTURES } from "./fixtures.ts";

console.log("Capturing real Google News RSS as test fixtures...");
const fetched = await ensureFixtures();
if (fetched.length === 0) {
  console.log("  all fixtures already present - nothing to do");
} else {
  console.log(`  wrote: ${fetched.join(", ")}`);
}
for (const f of FIXTURES) {
  console.log(`  ${f.label.padEnd(6)} ${f.domain}`);
}
