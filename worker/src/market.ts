/**
 * Market data for the "Money & Markets" section.
 *
 * FX comes from free, keyless providers that were verified reachable from
 * Cloudflare. Commodities (oil, gold) are NOT included: every free route found
 * either needs an API key (EIA, metals-api) or is no longer served
 * (Stooq now returns 404/HTML instead of CSV). Add one with a key before
 * promising those numbers.
 */

export interface FxRates {
  base: string;
  fetchedAt: string;
  /** e.g. 4048.83 for USD/KHR */
  perUsd: Record<string, number>;
  provider: string;
}

/** Currencies a Cambodian business actually prices in. */
export const TRACKED_CURRENCIES: { code: string; name: string; flag: string }[] = [
  { code: "KHR", name: "Cambodian Riel", flag: "\u{1F1F0}\u{1F1ED}" },
  { code: "THB", name: "Thai Baht", flag: "\u{1F1F9}\u{1F1ED}" },
  { code: "VND", name: "Vietnamese Dong", flag: "\u{1F1F7}\u{1F1F3}" },
  { code: "CNY", name: "Chinese Yuan", flag: "\u{1F1E8}\u{1F1F3}" },
  { code: "SGD", name: "Singapore Dollar", flag: "\u{1F1F8}\u{1F1EC}" },
  { code: "MYR", name: "Malaysian Ringgit", flag: "\u{1F1F2}\u{1F1FE}" },
  { code: "IDR", name: "Indonesian Rupiah", flag: "\u{1F1EE}\u{1F1E9}" },
  { code: "EUR", name: "Euro", flag: "\u{1F1EA}\u{1F1FA}" },
  { code: "JPY", name: "Japanese Yen", flag: "\u{1F1EF}\u{1F1F5}" },
];

const PROVIDERS = [
  { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD" },
  { name: "frankfurter.app", url: "https://api.frankfurter.app/latest?from=USD" },
];

export async function fetchFxRates(): Promise<FxRates | null> {
  for (const provider of PROVIDERS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(provider.url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = (await res.json()) as { rates?: Record<string, number> };
      const rates = data.rates ?? {};
      const perUsd: Record<string, number> = {};
      for (const c of TRACKED_CURRENCIES) {
        const v = rates[c.code];
        if (typeof v === "number" && v > 0) perUsd[c.code] = v;
      }
      // A provider that cannot quote KHR is not useful here.
      if (!perUsd.KHR) continue;
      return {
        base: "USD",
        fetchedAt: new Date().toISOString(),
        perUsd,
        provider: provider.name,
      };
    } catch {
      // try the next provider
    }
  }
  return null;
}

/** Approximate riel value of one unit of a currency, via USD. */
export function toKhr(code: string, fx: FxRates | null): number | null {
  if (!fx) return null;
  const perUsd = fx.perUsd[code];
  const khr = fx.perUsd.KHR;
  if (!perUsd || !khr) return null;
  return perUsd / khr;
}

export function formatRate(code: string, fx: FxRates | null): string {
  if (!fx) return "n/a";
  const v = fx.perUsd[code];
  if (v === undefined) return "n/a";
  // Large units (KHR, VND, IDR) get fewer decimals.
  const decimals = v >= 1000 ? 1 : v >= 10 ? 2 : 4;
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Human note about a currency move, used by the opportunity engine. */
export function fxSignal(fx: FxRates | null): string | null {
  if (!fx) return null;
  const khr = fx.perUsd.KHR;
  if (khr === undefined) return null;
  if (khr >= 4100) return "Riel is weak against the dollar (above 4,100). Importers pay more in KHR; USD-priced sellers and exporters benefit.";
  if (khr <= 3950) return "Riel is strong against the dollar (below 3,950). Import costs fall, which can pressure retail prices down.";
  return null;
}