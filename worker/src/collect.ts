/**
 * The collect -> classify -> store pipeline. Mirrors fetch_news() in app.py,
 * but fetches every source in parallel because Workers has a wall-clock limit.
 */
import {
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_MAX_ITEMS_PER_SOURCE,
  DEFAULT_MAX_RESOLVES,
  SOURCES,
} from "./config.ts";
import {
  applySourceDefault,
  isNearDuplicate,
  scoreArticle,
  titleHashKey,
  classify,
} from "./classify.ts";
import { buildCandidates, emptyStats, fetchSource, resolveAll, type Candidate, type FetchStats } from "./feeds.ts";
import { existsByHashOrGoogleUrl, insertArticle, recentTitlesForSource } from "./db.ts";

export interface CollectOptions {
  lookbackHours?: number;
  maxItemsPerSource?: number;
  maxResolves?: number;
  dupOverlap?: number;
}

export interface CollectResult extends FetchStats {
  durationMs: number;
}

export async function collectNews(db: D1Database, opts: CollectOptions = {}): Promise<CollectResult> {
  const started = Date.now();
  const lookbackHours = opts.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const maxItems = opts.maxItemsPerSource ?? DEFAULT_MAX_ITEMS_PER_SOURCE;
  const maxResolves = opts.maxResolves ?? DEFAULT_MAX_RESOLVES;
  const dupOverlap = opts.dupOverlap ?? 0.5;
  const stats = emptyStats();

  // 1. Fetch all 15 feeds in parallel.
  const fetched = await Promise.all(SOURCES.map((s) => fetchSource(s)));
  for (const r of fetched) if (r.error) stats.errors.push(r.error);

  // 2. Filter (domain / freshness / junk / Cambodia relevance).
  const candidates: Candidate[] = [];
  fetched.forEach((r, i) => {
    const source = SOURCES[i]!;
    if (r.entries.length === 0) return;
    candidates.push(...buildCandidates(source, r.entries, lookbackHours, maxItems, stats));
  });

  // 3. Drop exact duplicates and near-duplicates before spending requests on URL resolution.
  const survivors: Candidate[] = [];
  const hashes: string[] = [];
  const recentCache = new Map<string, string[]>();
  for (const c of candidates) {
    const hash = titleHashKey(c.title);
    if (await existsByHashOrGoogleUrl(db, hash, c.entry.link)) {
      stats.duplicate++;
      continue;
    }
    if (!recentCache.has(c.source.name)) {
      recentCache.set(c.source.name, await recentTitlesForSource(db, c.source.name, 24 * 7));
    }
    if (isNearDuplicate(c.title, recentCache.get(c.source.name)!, dupOverlap)) {
      stats.duplicate++;
      continue;
    }
    survivors.push(c);
    hashes.push(hash);
  }

  // 4. Resolve the real publisher URLs, in parallel, within budget.
  const links = survivors.map((s) => s.entry.link);
  const { resolved } = await resolveAll(links, maxResolves);
  stats.resolved = resolved.size;
  stats.unresolved = links.length - resolved.size;

  // 5. Classify, score and store.
  for (let i = 0; i < survivors.length; i++) {
    const c = survivors[i]!;
    const realUrl = resolved.get(c.entry.link) ?? c.entry.link;
    // Classify on the cleaned title only. Google's <summary> is not article text -
    // it repeats the headline including the publisher name, which mis-files
    // "Asian Development Bank" under the Banking category.
    const { category, signals } = classify(c.title);
    const applied = applySourceDefault(category, signals, c.source.name);
    const score = scoreArticle(applied.category, signals.length, c.source.tier, c.entry.ageHours);

    const res = await insertArticle(db, {
      title: c.title,
      title_hash: hashes[i]!,
      url: realUrl,
      google_url: c.entry.link,
      source: c.source.name,
      tier: c.source.tier,
      published: c.entry.published,
      age_hours: c.entry.ageHours,
      category: applied.category,
      score,
      summary: c.entry.summary.slice(0, 1200),
      signals: signals.slice(0, 6).join(", "),
      opportunity: applied.opportunity,
      action: applied.action,
    });

    if (res.inserted) stats.newCount++;
    else if ((res.error ?? "").includes("UNIQUE")) stats.duplicate++;
    else stats.errors.push(`${c.source.name}: insert failed: ${res.error}`);
  }

  return { ...stats, durationMs: Date.now() - started };
}
