/** Parity check: the Worker must classify identically to the Python version. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, PLAYBOOK, SOURCES } from "../src/config.ts";
import { classify } from "../src/classify.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Compares the Worker's config against a reference snapshot exported from
 * app.py, so the two implementations cannot drift apart unnoticed.
 *
 * Regenerate the snapshot after editing categories/playbooks in app.py:
 *   python -c "import ast,json,pathlib; ..."
 * (see DEPLOY.md) or simply accept the failure and copy the lists by hand.
 */
const py = JSON.parse(readFileSync(join(here, "python-reference.json"), "utf8")) as {
  CATEGORIES: Record<string, string[]>;
  PLAYBOOK: Record<string, [string, string]>;
};

let diffs = 0;
const report: string[] = [];

// --- keyword lists must match exactly ---
const pyCats = Object.keys(py.CATEGORIES).sort();
const tsCats = Object.keys(CATEGORIES).sort();
if (JSON.stringify(pyCats) !== JSON.stringify(tsCats)) {
  report.push(`category names differ:\n  python: ${pyCats}\n  ts    : ${tsCats}`);
  diffs++;
}
for (const cat of pyCats) {
  if (!CATEGORIES[cat]) continue;
  const a = [...py.CATEGORIES[cat]!].sort();
  const b = [...CATEGORIES[cat]!].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const onlyPy = a.filter((k) => !b.includes(k));
    const onlyTs = b.filter((k) => !a.includes(k));
    report.push(`"${cat}" keyword drift:\n  only in python: ${onlyPy}\n  only in ts    : ${onlyTs}`);
    diffs++;
  }
}

// --- playbook text must match exactly ---
for (const cat of Object.keys(py.PLAYBOOK).sort()) {
  const pyText = py.PLAYBOOK[cat]!.join("|");
  const tsText = PLAYBOOK[cat]?.join("|");
  if (pyText !== tsText) {
    report.push(`"${cat}" playbook text differs:\n  python: ${pyText}\n  ts    : ${tsText}`);
    diffs++;
  }
}

// --- sources must match exactly ---
if (pyCats.length === 0) report.push("no python categories loaded");

// --- and the two implementations must agree on real headlines ---
console.log(`categories: python=${pyCats.length} ts=${tsCats.length}`);
console.log(`playbooks : python=${Object.keys(py.PLAYBOOK).length} ts=${Object.keys(PLAYBOOK).length}`);
console.log(`sources   : ts=${SOURCES.length}`);

const headlines = [
  "Cambodia Sees Opportunity to Strengthen Trade and Investment with Chongqing",
  "The National Bank of Cambodia (NBC) held the semi-annual assembly to review the Working Results",
  "Cambodia Showcases Tourism Potential at G Adventures GX Summit 2026",
  "Huawei Highly Values Strong Cooperation with Cambodian Institutions in Technology Sector",
  "Cambodia: Greater Mekong Subregion Southern Economic Corridor Towns Development Project",
  "New garment factory to create 5,000 jobs in Phnom Penh",
  "Land title deed issuance programme expands to three provinces",
  "Tourist arrivals up 22% year on year, ministry says",
  "Ministry issues sub-decree on e-commerce registration",
  "Minimum wage for tourism workers raised",
];
console.log("\nclassification of sample headlines:");
for (const h of headlines) {
  const r = classify(h);
  console.log(`  ${r.category.padEnd(24)} ${h.slice(0, 62)}`);
}

console.log("");
if (diffs === 0) {
  console.log("PARITY OK - python and typescript agree on sources, keywords and playbook text");
} else {
  console.log(`${diffs} difference(s):`);
  for (const r of report) console.log("  - " + r);
  process.exit(1);
}
