/**
 * Static configuration, ported 1:1 from the Python version (app.py).
 *
 * Editing this file is how you add sources, categories and sales playbooks.
 * Nothing here is secret.
 */

export interface Source {
  name: string;
  domain: string;
  home: string;
  /** 1 = primary source (central bank, ministry, multilateral); 2 = state agency */
  tier: number;
  /** the source's own remit, used when no keyword matches the headline */
  defaultCategory: string | null;
}

export const SOURCES: Source[] = [
  { name: "AKP", domain: "akp.gov.kh", home: "https://akp.gov.kh/", tier: 2, defaultCategory: null },
  { name: "MEF", domain: "mef.gov.kh", home: "https://mef.gov.kh/", tier: 1, defaultCategory: "Cambodia Economy" },
  { name: "NBC", domain: "nbc.gov.kh", home: "https://www.nbc.gov.kh/", tier: 1, defaultCategory: "Banking" },
  { name: "CIB / CDC", domain: "cib-cdc.gov.kh", home: "https://cib-cdc.gov.kh/en", tier: 1, defaultCategory: "Investment" },
  { name: "NIS", domain: "nis.gov.kh", home: "https://nis.gov.kh/en/main-page-2/", tier: 1, defaultCategory: "Cambodia Economy" },
  { name: "MLVT", domain: "mlvt.gov.kh", home: "https://www.mlvt.gov.kh/", tier: 1, defaultCategory: "Jobs & Hiring" },
  { name: "Ministry of Commerce", domain: "moc.gov.kh", home: "https://www.moc.gov.kh/", tier: 1, defaultCategory: "Marketplace" },
  { name: "Ministry of Tourism", domain: "tourism.gov.kh", home: "https://www.tourism.gov.kh/", tier: 1, defaultCategory: "Tourism" },
  { name: "Ministry of Land Management", domain: "mlmupc.gov.kh", home: "https://mlmupc.gov.kh/", tier: 1, defaultCategory: "Property" },
  { name: "Customs & Excise", domain: "tax.gov.kh", home: "https://www.tax.gov.kh/", tier: 1, defaultCategory: "Government & Regulation" },
  { name: "IMF Cambodia", domain: "imf.org", home: "https://www.imf.org/en/Countries/KHM", tier: 1, defaultCategory: "Cambodia Economy" },
  { name: "World Bank Cambodia", domain: "worldbank.org", home: "https://www.worldbank.org/en/country/cambodia", tier: 1, defaultCategory: "Cambodia Economy" },
  { name: "ADB Cambodia", domain: "adb.org", home: "https://www.adb.org/countries/cambodia/main", tier: 1, defaultCategory: "Investment" },
  { name: "ASEAN", domain: "asean.org", home: "https://asean.org/", tier: 1, defaultCategory: "Cambodia Economy" },
  { name: "WTO", domain: "wto.org", home: "https://www.wto.org/", tier: 1, defaultCategory: "Marketplace" },
];

export const SOURCE_BY_NAME: Record<string, Source> = Object.fromEntries(
  SOURCES.map((s) => [s.name, s]),
);

export const hostOf = (home: string): string =>
  home.replace(/^https?:\/\//, "").split("/")[0]!.toLowerCase();

/**
 * `site:asean.org Cambodia` also returns pan-regional news ("ASEAN
 * Secretary-General meets the Governor of New South Wales"). For the
 * multi-country bodies we require the article to actually mention Cambodia.
 */
export const CAMBODIA_MARKERS = ["cambodia", "cambodian", "phnom penh", "កម្ពុជា", "ភ្នំពេញ"];
export const BROAD_DOMAINS = new Set(["imf.org", "worldbank.org", "adb.org", "asean.org", "wto.org"]);

export const GENERAL_CATEGORY = "General Business";

/**
 * Word-boundary keyword matching, so "ev" cannot fire inside "review" and
 * "ai" cannot fire inside "training". ASCII keywords use boundaries; Khmer
 * keywords use substring matching because Khmer is not space-delimited.
 */
export const CATEGORIES: Record<string, string[]> = {
  "Cambodia Economy": [
    "economy", "gdp", "inflation", "growth", "fiscal", "budget", "revenue",
    "monetary", "deficit", "tariff", "national account", "balance of payments",
    "gross domestic", "expenditure", "productivity", "សេដ្ឋកិច្ច",
  ],
  "Investment": [
    "investment", "investor", "factory", "project", "capital", "cdc", "fdi",
    "foreign direct", "special economic zone", "concession", "manufacturing",
    "assembly plant", "joint venture", "power plant", "solar plant", "solar farm",
    "wind farm", "hydropower", "renewable energy", "electricity", "utility",
    "វិនិយោគ",
  ],
  "Jobs & Hiring": [
    "job", "jobs", "employment", "hiring", "worker", "workers", "salary",
    "skill", "skills", "labor", "labour", "wage", "wages", "recruitment",
    "unemployment", "vocational", "apprentice", "minimum wage", "human resource",
    "ការងារការងារ",
  ],
  "Property": [
    "property", "real estate", "construction", "condo", "condominium", "land",
    "housing", "apartment", "title deed", "land title", "urban development",
    "tower", "residence", "សំណង់", "ដីសម្គាល់",
  ],
  "Auto": [
    "automotive", "vehicle", "vehicles", "electric vehicle", "ev battery",
    "dealer", "motorcycle", "car import", "vehicle import", "showroom",
    "រថយន្ត",
  ],
  "Marketplace": [
    "consumer", "retail", "e-commerce", "ecommerce", "trade", "export",
    "exportation", "import", "marketplace", "supermarket", "wholesale",
    "distribution", "sme", "នាំចេញ", "នាំចូល",
  ],
  "Banking": [
    "bank", "loan", "credit", "interest rate", "finance", "fintech",
    "microfinance", "deposit", "lending", "digital payment", "payment",
    "mobile money", "liquidity", "ធនាគារ", "បញ្ចូល",
  ],
  "Technology & AI": [
    "technology", "digital", "artificial intelligence", "software",
    "startup", "data center", "telecom", "5g", "mobile network",
    "cybersecurity", "broadband", "fiber", "innovation", "ai", "បច្ចេកវិទ្យា",
  ],
  "Government & Regulation": [
    "law", "regulation", "policy", "tax", "government", "ministry",
    "royal decree", "sub-decree", "legal", "customs", "official gazette",
    "licence", "license", "permit", "state council", "រដ្ឋបាល", "ច្បាប់",
  ],
  "Tourism": [
    "tourism", "tourist", "tourists", "hotel", "travel", "visitor arrivals",
    "hospitality", "flight", "airline", "airport", "resort", "ecotourism",
    "ទេសនា",
  ],
};

export type Playbook = [opportunity: string, action: string];

export const PLAYBOOK: Record<string, Playbook> = {
  "Investment": [
    "Potential new B2B leads: investor, factory, supplier or HR teams entering Cambodia.",
    "Create a lead and contact the company within 24 hours.",
  ],
  "Jobs & Hiring": [
    "Potential Job-category demand from employers and recruiters.",
    "Identify hiring companies and pitch Khmer24 Job packages.",
  ],
  "Property": [
    "Potential demand from developers, agents and property sellers.",
    "Target developers/agents with Property advertising packages.",
  ],
  "Auto": [
    "Potential demand from dealers and vehicle sellers.",
    "Identify active dealers and offer Auto advertising/business packages.",
  ],
  "Marketplace": [
    "Potential seller/category demand based on consumer and trade signals.",
    "Identify affected seller categories and launch targeted outreach.",
  ],
  "Banking": [
    "Potential change in purchasing power or financing demand.",
    "Review Auto/Property customer demand and partnership opportunities.",
  ],
  "Technology & AI": [
    "Potential new customer segment, jobs and product opportunities.",
    "Create a target list of companies and relevant Job/Business packages.",
  ],
  "Cambodia Economy": [
    "Macro signal that may affect customer demand and sales conversion.",
    "Review targets, promotions and customer segments.",
  ],
  "Government & Regulation": [
    "Potential market or compliance change.",
    "Identify affected customer groups and prepare a sales/product response.",
  ],
  "Tourism": [
    "Potential impact on hospitality, jobs, retail and local demand.",
    "Target hospitality/tourism employers and businesses.",
  ],
};

export const GENERAL_PLAYBOOK: Playbook = [
  "Business signal requiring review.",
  "No category keyword matched - open the article and classify it by hand.",
];

/** Placeholder / section pages that pollute the dashboard. */
export const JUNK_TITLES = new Set(["untitled", "no title", "home", "index", "news", "n/a", "-"]);

export const JUNK_PHRASES = [
  "news items", "news item", "news update", "news flash", "agrifood news",
  "press release", "archive", "archives", "announcements", "announcement",
  "tenders", "procurement", "notices", "newsletter", "gallery", "events",
  "media centre", "media center", "sitemap", "subscribe", "login",
  // Cambodian government CMS pages habitually title every article
  // "Content Detail" / "Article Detail" instead of using the headline.
  "content detail", "article detail", "news detail", "view detail", "detail",
  "welcome", "home page",
];

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const DEFAULT_LOOKBACK_HOURS = 72;
export const DEFAULT_MAX_ITEMS_PER_SOURCE = 15;
export const DEFAULT_MAX_RESOLVES = 40;
export const REQUEST_TIMEOUT_MS = 20_000;
/** Telegram rejects anything longer. */
export const TELEGRAM_MAX_LEN = 4096;

// --- streaming alerts: send each article as its source publishes it ---
export const DEFAULT_STREAM_ALERTS = true;
export const DEFAULT_ALERT_BATCH_SIZE = 3;
/** Cap per tick, so one source bulk-uploading cannot flood the chat. */
export const DEFAULT_ALERT_MAX_PER_TICK = 20;
