/** HTML view of the 8-section Business Intelligence report. */
import { esc } from "./html.ts";
import { SECTION_META } from "./registry.ts";
import type { IntelReport } from "./intel.ts";

const STYLE = `
*{box-sizing:border-box}
body{font-family:"Segoe UI",Arial,sans-serif;background:#f4f6fa;margin:0;color:#16202e}
header{background:#0f172a;color:#fff;padding:20px 5%}
.wrap{max-width:1080px;margin:22px auto;padding:0 16px}
.card{background:#fff;border-radius:14px;padding:18px 20px;margin:14px 0;box-shadow:0 1px 3px #0f172a14}
h1{margin:0 0 4px;font-size:23px}
h2{font-size:16px;margin:0 0 12px;letter-spacing:.4px}
.meta{color:#64748b;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px}
.tile{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:17px}
.muted{color:#64748b;font-size:13px}
ol{margin:0;padding-left:20px}
li{margin-bottom:12px}
.act{background:#ecfdf5;border-left:3px solid #0f766e;padding:8px 11px;border-radius:0 8px 8px 0;margin:6px 0;font-size:14px}
.why{color:#475569;font-size:13px;margin:4px 0}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.tag{display:inline-block;background:#eef2ff;border-radius:20px;padding:3px 9px;font-size:11px;margin-right:5px}
.urg-act{background:#fee2e2;color:#991b1b}
.urg-week{background:#fef3c7;color:#92400e}
.urg-watch{background:#e2e8f0;color:#334155}
.warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:10px;padding:12px 14px;margin:10px 0;font-size:14px}
.money{font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.7;white-space:pre-wrap}
.empty{color:#94a3b8;font-style:italic}
footer{color:#64748b;font-size:12px;text-align:center;padding:24px}
`;

export function renderIntel(report: IntelReport): string {
  const tiles = report.sections
    .filter((s) => s.section !== "money" && s.section !== "opportunity")
    .map(
      (s) => `      <div class="tile"><b>${countNews(s.lines)}</b><span class="muted">${esc(s.emoji)} ${esc(s.title)}</span></div>`,
    )
    .join("\n");

  const blocks = report.sections
    .map((block) => {
      const isOpp = block.section === "opportunity";
      const body = isOpp ? renderOpportunities(report) : renderLines(block.lines);
      const title = isOpp
        ? `${block.emoji} WHAT SHOULD KHMER24 DO TODAY?`
        : `${block.emoji} ${block.title}`;
      return `  <div class="card">
    <h2>${esc(title)}</h2>
${body}
  </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Khmer24 Business Intelligence</title><style>${STYLE}</style></head>
<body>
<header>
  <h1>\u{1F1F0}\u{1F1ED} Khmer24 Business Intelligence</h1>
  <div class="meta">NEWS &rarr; IMPACT &rarr; CUSTOMER &rarr; OPPORTUNITY &rarr; ACTION</div>
</header>
<div class="wrap">
  <div class="card">
    <div class="meta">Generated ${esc(new Date(report.generatedAt).toISOString().replace("T", " ").slice(0, 16))} UTC &middot;
      ${report.totalArticles} signals &middot; ${report.opportunities.length} opportunities</div>
    <div class="grid">
${tiles}
    </div>
  </div>
${
  report.warnings.length
    ? `  <div class="warn"><b>Coverage gaps:</b> ${report.warnings.map(esc).join(" &middot; ")}</div>\n`
    : ""
}${blocks}
  <div class="card">
    <h2>Send this report</h2>
    <div class="muted">Requires the admin key. Reads and sends; it does not write to the database.</div>
    <p><a href="/">Back to the signals dashboard</a> &middot; <a href="/health">/health</a></p>
  </div>
</div>
<footer>Cloudflare Worker + D1 &middot; FX from ${report.fx ? esc(report.fx.provider) : "unavailable"}</footer>
</body></html>`;
}

function countNews(lines: string[]): number {
  return lines.filter((l) => /^\d+\./.test(l)).length;
}

function renderLines(lines: string[]): string {
  if (lines.length === 0) return `    <div class="empty">Nothing to report.</div>`;
  const numbered = lines.filter((l) => /^\d+\./.test(l));
  if (numbered.length === 0) {
    return `    <div class="money">${lines.map(esc).join("\n")}</div>`;
  }
  const items: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (/^\d+\./.test(l) && cur.length) {
      items.push(cur.join("\n"));
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) items.push(cur.join("\n"));
  return `    <ol>\n${items.map((i) => `      <li>${i.split("\n").map(esc).join("<br>")}</li>`).join("\n")}\n    </ol>`;
}

function renderOpportunities(report: IntelReport): string {
  if (report.opportunities.length === 0) {
    return `    <div class="empty">No strong signals in the last 72 hours. Hold the pipeline steady.</div>`;
  }
  return `    <ol>
${report.opportunities
  .map(
    (o) => `      <li>
        <span class="tag urg-${o.urgency === "act today" ? "act" : o.urgency === "this week" ? "week" : "watch"}">${esc(o.urgency)}</span>
        <b>${esc(o.headline)}</b>
        ${o.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}
        <div class="why">${o.because.map((b) => esc(b)).join("<br>")}</div>
        <div class="why"><b>Customer:</b> ${esc(o.customer)}</div>
        <div class="act"><b>Action:</b> ${esc(o.action)}</div>
      </li>`,
  )
  .join("\n")}
    </ol>`;
}

export { SECTION_META };
