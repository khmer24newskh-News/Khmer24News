/** Settings page: choose which sections, sources and categories reach the brief. */
import { esc } from "./html.ts";
import { SECTION_META } from "./registry.ts";
import { CATEGORIES, GENERAL_CATEGORY } from "./config.ts";
import { sourcesByGroup, URGENCIES, ALERT_STYLES, ALL_SECTIONS, type AlertStylePref, type Prefs } from "./prefs.ts";

/** Plain-language explanations for the alert style dropdown. */
const ALERT_STYLE_HELP: Record<AlertStylePref, { label: string; note: string }> = {
  breaking: {
    label: "Cards for high severity (recommended)",
    note:
      "A story that clears the bar arrives as its own card with the category, the " +
      "publisher, the summary and one line on what it means for Cambodia. Everything " +
      "else is a short batched list.",
  },
  cards: {
    label: "A card for every story",
    note:
      "Every article gets the full card, including routine ones. Readable, but it " +
      "interrupts a lot. A poll run can insert 15-20 articles.",
  },
  compact: {
    label: "Short list only (as before)",
    note: "No cards. Headline, source, category and opportunity, batched a few per message.",
  },
};

/** Exported so the test can prove every dropdown option is explained. */
export const ALERT_STYLE_HELP_FOR_TESTS = ALERT_STYLE_HELP;

const STYLE = `
*{box-sizing:border-box}
body{font-family:"Segoe UI",Arial,sans-serif;background:#f4f6fa;margin:0;color:#16202e}
header{background:#0f172a;color:#fff;padding:20px 5%}
.wrap{max-width:1000px;margin:22px auto;padding:0 16px}
.card{background:#fff;border-radius:14px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px #0f172a14}
h1{margin:0 0 4px;font-size:22px}
h2{font-size:15px;margin:0 0 12px;letter-spacing:.3px}
.meta{color:#64748b;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
label.opt{display:flex;gap:9px;align-items:flex-start;padding:9px 11px;border:1px solid #e2e8f0;border-radius:9px;cursor:pointer;font-size:14px}
label.opt:hover{background:#f8fafc}
label.opt input{margin-top:2px}
.how{color:#94a3b8;font-size:11px;display:block}
.bar{position:sticky;bottom:0;background:#fff;border-top:1px solid #e2e8f0;padding:12px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button,.btn{background:#0f172a;color:#fff;border:0;border-radius:9px;padding:11px 16px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block}
button.g{background:#0f766e}
button.r{background:#b91c1c}
input[type=number]{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;width:90px}
select{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px}
.flash{border-radius:9px;padding:11px 14px;margin:10px 0;font-size:14px}
.ok{background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46}
.err{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b}
.warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:9px;padding:11px 14px;margin:10px 0;font-size:13px}
a{color:#2563eb}
footer{color:#64748b;font-size:12px;text-align:center;padding:22px}
`;

export function renderSettings(
  prefs: Prefs,
  opts: { saved?: boolean; error?: string; counts: Record<string, number>; basePath: string },
): string {
  const on = <T,>(list: T[], v: T) => (list.includes(v) ? "checked" : "");

  const sectionBoxes = ALL_SECTIONS.map((s) => {
    const m = SECTION_META[s];
    const n = opts.counts[s] ?? 0;
    return `        <label class="opt"><input type="checkbox" name="sections" value="${s}" ${on(prefs.sections, s)}>
          <span><b>${m.emoji} ${esc(m.title)}</b><span class="how">${n} signal(s) stored</span></span></label>`;
  }).join("\n");
  const sourceBoxes = sourcesByGroup()
    .map(
      (g) => `      <h2>${esc(g.title)}</h2>
      <div class="grid">
${g.items
  .map(
    (s) => `        <label class="opt"><input type="checkbox" name="sources" value="${esc(s.id)}" ${on(prefs.sources, s.id)}>
          <span><b>${esc(s.label)}</b><span class="how">${esc(s.how)}</span></span></label>`,
  )
  .join("\n")}
      </div>`,
    )
    .join("\n");

  const categories = [...Object.keys(CATEGORIES), GENERAL_CATEGORY];
  const catBoxes = categories
    .map(
      (c) => `        <label class="opt"><input type="checkbox" name="categories" value="${esc(c)}" ${on(prefs.categories, c)}>
          <span><b>${esc(c)}</b></span></label>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Khmer24 - What to watch</title><style>${STYLE}</style></head>
<body>
<header><h1>What to watch</h1>
<div class="meta">Choose what reaches your daily brief. Changes apply to the next report, including the 07:30 send.</div></header>
<div class="wrap">
${opts.saved ? '  <div class="flash ok">Saved. The next brief will follow these settings.</div>' : ""}
${opts.error ? `  <div class="flash err">${esc(opts.error)}</div>` : ""}
  <div class="warn">
    Money and Business Opportunities are the core of the brief. Turn everything else off if you
    only want the daily decision list.
  </div>
  <form method="post" action="${esc(opts.basePath)}/settings">
    <div class="card">
      <h2>Sections</h2>
      <div class="grid">
${sectionBoxes}
      </div>
    </div>
    <div class="card">
      <h2>Delivery</h2>
      <div class="grid">
        <label class="opt"><input type="checkbox" name="auto_send" ${prefs.autoSend ? "checked" : ""}>
          <span><b>Send automatically at 07:30</b><span class="how">Otherwise the brief is only sent when you ask.</span></span></label>
        <label class="opt"><input type="checkbox" name="ai" ${prefs.ai ? "checked" : ""}>
          <span><b>Include the AI analyst</b><span class="how">One extra model call per report. Appended after the rule-based list.</span></span></label>
        <label class="opt"><span><b>Window</b>
          <span class="how">How far back signals count</span>
          <input type="number" name="hours" value="${prefs.hours}" min="1" max="720"></span></label>
        <label class="opt"><span><b>Minimum urgency</b>
          <span class="how">Hide anything less urgent</span>
          <select name="min_urgency">
${URGENCIES.map((u) => `            <option value="${u}" ${prefs.minUrgency === u ? "selected" : ""}>${u}</option>`).join("\n")}
          </select></span></label>
      </div>
    </div>
    <div class="card">
      <h2>Breaking-news alerts</h2>
      <div class="grid">
        <label class="opt"><span><b>Alert style</b>
          <span class="how">How a new story reaches you</span>
          <select name="alert_style">
${ALERT_STYLES.map((s) => `            <option value="${s}" ${prefs.alertStyle === s ? "selected" : ""}>${ALERT_STYLE_HELP[s]!.label}</option>`).join("\n")}
          </select>
          <span class="how">${ALERT_STYLE_HELP[prefs.alertStyle]!.note}</span></span></label>
        <label class="opt"><input type="checkbox" name="breaking_only" ${prefs.breakingOnly ? "checked" : ""}>
          <span><b>Only send HIGH severity</b><span class="how">Silence the routine items entirely. Use this if alerts still feel noisy.</span></span></label>
      </div>
    </div>
    <div class="card">
      <h2>Sources</h2>
${sourceBoxes}
      <p class="meta">Sources marked "pushed from your PC" are fetched by the local task, because Google News refuses Cloudflare. Sources marked "no feed yet" are placeholders.</p>
    </div>
    <div class="card">
      <h2>Categories that count as opportunities</h2>
      <div class="grid">
${catBoxes}
      </div>
    </div>
    <div class="bar">
      <button class="g" type="submit">Save settings</button>
      <a class="btn" href="${esc(opts.basePath)}/intel">Preview the brief</a>
      <a class="btn" href="${esc(opts.basePath)}/">Signals dashboard</a>
      <span class="meta">Sections and sources left unticked simply will not appear.</span>
    </div>
  </form>
</div>
<footer>Cloudflare Worker + D1 &middot; <a href="${esc(opts.basePath)}/health">/health</a></footer>
</body></html>`;
}
