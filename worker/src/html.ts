/**
 * Server-rendered dashboard. Same feature set as the Flask template:
 * stat cards, category mix, category/window filter, signal list, flash messages.
 */
import { SOURCES } from "./config.ts";
import { prettyAge } from "./classify.ts";
import type { Article } from "./db.ts";
import { safeExternalUrl } from "./report.ts";

export const esc = (s: string | null | undefined): string =>
  (s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const STYLE = `
*{box-sizing:border-box}
body{font-family:"Segoe UI",Arial,sans-serif;background:#f5f7fb;margin:0;color:#172033}
header{background:#111827;color:#fff;padding:22px 5%;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
h1{margin:0;font-size:24px}.wrap{max-width:1200px;margin:25px auto;padding:0 18px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 2px 10px #0000000d}
.num{font-size:28px;font-weight:700}.actions{display:flex;gap:10px;margin:20px 0;flex-wrap:wrap}
button,.btn{background:#111827;color:#fff;border:0;border-radius:9px;padding:11px 15px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block}
button:hover,.btn:hover{opacity:.9}.green{background:#0f766e}
.article{background:#fff;border-radius:12px;padding:17px;margin:12px 0}
.tag{display:inline-block;background:#eef2ff;border-radius:20px;padding:5px 9px;font-size:12px;margin:0 6px 6px 0}
.sig{background:#f1f5f9;color:#475569}.score{float:right;font-weight:700;color:#0f766e}
.muted{color:#6b7280;font-size:13px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.article h3{margin:8px 0 4px}
.flash{border-radius:10px;padding:12px 15px;margin:10px 0;font-size:14px}
.flash-ok{background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46}
.flash-info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
.flash-error{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b}
.warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:10px;padding:12px 15px;margin:10px 0;font-size:14px}
form.filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0}
select,input{font-size:14px}select,input[type=number]{padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}
.bar{height:6px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-top:7px}
.bar>span{display:block;height:100%;background:linear-gradient(90deg,#0f766e,#10b981)}
footer{color:#6b7280;font-size:12px;text-align:center;padding:26px 10px}
@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}}
`;

export interface Flash {
  kind: "ok" | "info" | "error";
  text: string;
}

export interface DashboardData {
  articles: Article[];
  counts: { category: string; n: number }[];
  totals: Record<string, number>;
  hours: number;
  category: string;
  flashes: Flash[];
  telegramReady: boolean;
  isAdmin: boolean;
  /** the key the current request used, so admin links keep working */
  adminKey: string;
  basePath: string;
}

export function renderDashboard(d: DashboardData): string {
  const total = d.counts.reduce((s, c) => s + c.n, 0);
  const top = d.counts[0]?.n ?? 1;
  const sum = (cat: string) => d.totals[cat] ?? 0;

  const flashes = d.flashes
    .map((f) => `  <div class="flash flash-${f.kind}">${esc(f.text)}</div>`)
    .join("\n");

  const categories = ["all", ...d.counts.map((c) => c.category)]
    .map((c) => {
      const sel = c === d.category ? " selected" : "";
      return `        <option value="${esc(c)}"${sel}>${c === "all" ? "All" : esc(c)}</option>`;
    })
    .join("\n");

  const mix = d.counts
    .filter((c) => c.n / top > 0.34)
    .map(
      (c) => `      <div style="margin-top:8px;font-size:13px">
        ${esc(c.category)} <span class="muted">(${c.n})</span>
        <div class="bar"><span style="width:${Math.round((c.n / top) * 100)}%"></span></div>
      </div>`,
    )
    .join("\n");

  const articles = d.articles.length
    ? d.articles
        .map((a) => {
          const signals = (a.signals ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => `<span class="tag sig">${esc(s)}</span>`)
            .join("");
          return `  <div class="article">
    <span class="tag">${esc(a.category)}</span>
    <span class="tag">${esc(a.source)}</span>
    <span class="score">Score ${a.score}</span>
    <h3>${esc(a.title)}</h3>
    <div class="muted">${esc(a.published ?? "")} · ${esc(prettyAge(a.age_hours))}</div>
    ${signals ? `<div style="margin:7px 0">${signals}</div>` : ""}
    <p><b>Opportunity:</b> ${esc(a.opportunity)}</p>
    <p><b>Action:</b> ${esc(a.action)}</p>
    <a href="${esc(safeExternalUrl(a.url))}" target="_blank" rel="noopener noreferrer">Open source →</a>
  </div>`;
        })
        .join("\n")
    : `  <div class="card">No signals in the last ${d.hours} hours.<br><br>Widen the window
     (e.g. <b>720</b> hours) to backfill${
       d.isAdmin ? ", or trigger a collect" : ""
     }.</div>`;

  const sources = SOURCES.map(
    (s) => `    <div style="padding:7px 0;border-bottom:1px solid #f1f5f9">
      <b>${esc(s.name)}</b> <span class="muted">tier ${s.tier} · ${esc(s.domain)}</span> —
      <a href="${esc(s.home)}" target="_blank" rel="noopener noreferrer">${esc(s.home)}</a>
    </div>`,
  ).join("\n");

  const adminButtons = d.isAdmin
    ? `
  <div class="actions">
    <a class="btn" href="${esc(d.basePath)}/collect?key=${encodeURIComponent(d.adminKey)}">↻ Fetch Official News</a>
    <a class="btn green" href="${esc(d.basePath)}/send?key=${encodeURIComponent(d.adminKey)}">✈ Send Daily Report to Telegram</a>
  </div>`
    : "";

  const telegramWarn = d.telegramReady
    ? ""
    : `  <div class="warn">Telegram is not configured, so the daily report will fail. Set
    <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> as Worker secrets.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Khmer24 Business Intelligence</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div>
    <h1>Khmer24 Business Intelligence</h1>
    <div class="muted" style="color:#cbd5e1">News → Signal → Money → Customer → Action</div>
  </div>
  <div class="muted" style="color:#cbd5e1;text-align:right">
    Window: last ${d.hours}h<br>
    ${d.telegramReady ? "Telegram: configured" : '<b style="color:#fcd34d">Telegram: not configured</b>'}
  </div>
</header>
<div class="wrap">
${flashes}
${telegramWarn}${adminButtons}
  <div class="grid">
    <div class="card"><div class="num">${total}</div><div>Signals (last ${d.hours}h)</div></div>
    <div class="card"><div class="num">${sum("Investment")}</div><div>Investment</div></div>
    <div class="card"><div class="num">${sum("Jobs & Hiring")}</div><div>Jobs</div></div>
    <div class="card"><div class="num">${sum("Property")}</div><div>Property</div></div>
  </div>
${
  d.counts.length
    ? `  <div class="card" style="margin-top:14px">
    <b>Category mix</b>
${mix}
  </div>`
    : ""
}
  <form class="filter" method="get" action="${esc(d.basePath)}/">
    <label>Category
      <select name="category">
${categories}
      </select>
    </label>
    <label>Window <input type="number" name="hours" value="${d.hours}" min="1" max="720" style="width:80px"> h</label>
    <button type="submit">Apply</button>
    <a class="muted" href="${esc(d.basePath)}/" style="margin-left:8px">reset</a>
  </form>
  <h2>Top Business Signals</h2>
${articles}
  <h2>Configured Sources</h2>
  <div class="card">
${sources}
  </div>
</div>
<footer>Cloudflare Worker + D1 · <a href="${esc(d.basePath)}/health">/health</a>${
    d.isAdmin
      ? ` · <a href="${esc(d.basePath)}/api/articles?hours=${d.hours}&key=${encodeURIComponent(d.adminKey)}">/api/articles</a>`
      : ""
  }</footer>
</body>
</html>`;
}
