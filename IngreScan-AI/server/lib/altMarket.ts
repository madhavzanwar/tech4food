/**
 * Real price / availability information for healthier alternatives, from two public crowd-sourced sources:
 *  - Open Food Facts (OFF): product search -> code, brands, stores, countries, Nutri-Score, image
 *  - Open Prices: community-reported prices for a product code
 *
 * Nothing is ever invented: a product is only reported when a conservative similarity rule passes
 * (see matchProduct), prices are shown in the currency they were reported in (no conversion), and any failure
 * degrades to { status: "unavailable" } instead of throwing.
 *
 * UNVERIFIED: written against the documented response shapes only. The sandbox that built this had no route to
 * the live hosts, so field names (several spellings are accepted) were never checked against live responses.
 * See docs/alternatives-market-data.md.
 */
import { getOffBaseUrl } from "./offClient";

export const DEFAULT_OPEN_PRICES_BASE_URL = "https://prices.openfoodfacts.org";
export const FETCH_TIMEOUT_MS = 6000;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_PARALLEL_FETCHES = 3;
export const STALE_AFTER_DAYS = 365;
/** Prices more than this many days older than the newest comparable price are left out of min/max. */
export const PRICE_WINDOW_DAYS = 180;
const DAY_MS = 86_400_000;

export class MarketUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MarketUnavailableError";
  }
}

// ---------------------------------------------------------------- config

/** Resolve the Open Prices site origin from OPEN_PRICES_BASE_URL (read on every call). */
export function getOpenPricesBaseUrl(): string {
  const raw = (process.env.OPEN_PRICES_BASE_URL ?? "").trim();
  if (!raw) return DEFAULT_OPEN_PRICES_BASE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    return raw.replace(/\/+$/, "");
  } catch {
    console.error(`[OpenPrices] Ignoring invalid OPEN_PRICES_BASE_URL; using ${DEFAULT_OPEN_PRICES_BASE_URL}`);
    return DEFAULT_OPEN_PRICES_BASE_URL;
  }
}

// ---------------------------------------------------------------- countries

export type Country = { code: string; name: string };

const COUNTRIES: Array<Country & { aliases?: string[] }> = [
  { code: "IN", name: "India", aliases: ["bharat"] },
  { code: "US", name: "United States", aliases: ["usa", "u.s.", "u.s.a.", "united states of america", "america"] },
  { code: "GB", name: "United Kingdom", aliases: ["uk", "u.k.", "england", "scotland", "wales", "great britain", "britain"] },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "IE", name: "Ireland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany", aliases: ["deutschland"] },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PT", name: "Portugal" },
  { code: "NL", name: "Netherlands", aliases: ["holland", "the netherlands"] },
  { code: "BE", name: "Belgium" },
  { code: "CH", name: "Switzerland" },
  { code: "AT", name: "Austria" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" },
  { code: "PL", name: "Poland" },
  { code: "BR", name: "Brazil" },
  { code: "MX", name: "Mexico" },
  { code: "AR", name: "Argentina" },
  { code: "CL", name: "Chile" },
  { code: "CO", name: "Colombia" },
  { code: "ZA", name: "South Africa" },
  { code: "NG", name: "Nigeria" },
  { code: "KE", name: "Kenya" },
  { code: "EG", name: "Egypt" },
  { code: "AE", name: "United Arab Emirates", aliases: ["uae", "dubai", "abu dhabi"] },
  { code: "SA", name: "Saudi Arabia" },
  { code: "TR", name: "Turkey" },
  { code: "PK", name: "Pakistan" },
  { code: "BD", name: "Bangladesh" },
  { code: "LK", name: "Sri Lanka" },
  { code: "NP", name: "Nepal" },
  { code: "ID", name: "Indonesia" },
  { code: "MY", name: "Malaysia" },
  { code: "SG", name: "Singapore" },
  { code: "TH", name: "Thailand" },
  { code: "VN", name: "Vietnam" },
  { code: "PH", name: "Philippines" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea", aliases: ["korea"] },
];

const COUNTRY_INDEX = new Map<string, Country>();
for (const { aliases = [], ...c } of COUNTRIES) {
  for (const k of [c.name.toLowerCase(), c.code.toLowerCase(), ...aliases]) COUNTRY_INDEX.set(k, c);
}

/** Free-text region ("Mumbai, India", "IN", "uk") -> known country, or null (then searches go worldwide). */
export function countryFromRegion(region: string | null | undefined): Country | null {
  if (!region) return null;
  const parts = region.split(/[,;/|]/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = COUNTRY_INDEX.get(parts[i]);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- safe field helpers

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function splitList(v: unknown): string[] {
  const raw = typeof v === "string" ? v.split(",") : arr(v).map(str);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const t = str(item).replace(/\s+/g, " ").slice(0, 80);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function titleCase(s: string): string {
  return s.replace(/-/g, " ").replace(/(^|\s)(\S)/g, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

// ---------------------------------------------------------------- OFF parsing

export type OffCandidate = {
  code: string;
  name: string;
  brand: string;
  stores: string[];
  countries: string[];
  nutriscore: string | null;
  image: string | null;
};

export function parseOffSearch(data: unknown): OffCandidate[] {
  const out: OffCandidate[] = [];
  for (const p of arr(rec(data).products)) {
    const r = rec(p);
    const code = str(r.code) || str(r._id);
    if (!/^\d{4,20}$/.test(code)) continue;
    const name = str(r.product_name) || str(r.product_name_en) || str(r.generic_name);
    if (!name) continue;
    const grade = str(r.nutriscore_grade).toLowerCase();
    const image = str(r.image_front_small_url) || str(r.image_small_url) || str(r.image_front_url);
    const storesRaw = str(r.stores) ? r.stores : arr(r.stores_tags).map((t) => titleCase(str(t).replace(/^[a-z]{2}:/, "")));
    out.push({
      code,
      name: name.slice(0, 200),
      brand: str(r.brands).slice(0, 200),
      stores: splitList(storesRaw),
      countries: splitList(arr(r.countries_tags).map((t) => titleCase(str(t).replace(/^[a-z]{2}:/, "")))),
      nutriscore: /^[a-e]$/.test(grade) ? grade.toUpperCase() : null,
      image: image && isHttpUrl(image) ? image : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- matching

const STOPWORDS = new Set(["the", "a", "an", "and", "of", "with", "in", "for", "de", "la", "le", "by", "from", "pack", "g", "gm", "kg", "ml", "l"]);

export function tokenize(s: string): string[] {
  const norm = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ");
  const out: string[] = [];
  for (const raw of norm.split(/\s+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue; // bare quantities are not identifying
    // minimal plural folding: "oats"/"oat", "cookies"/"cookie"; never touches short words or "ss" endings
    const t = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    out.push(t);
  }
  return out;
}

export type MatchQuery = { productName: string; brand?: string | null };

export type MatchResult<T extends { code: string; name: string; brand: string }> = { candidate: T; score: number } | null;

/** Brand lists in OFF are comma separated ("Nestle, Maggi"); every brand token of the wanted brand must be in one entry. */
function brandMatches(wantedBrand: string, candidateBrands: string): boolean {
  const want = tokenize(wantedBrand);
  if (want.length === 0) return true;
  for (const entry of candidateBrands.split(",")) {
    const have = new Set(tokenize(entry));
    if (have.size > 0 && want.every((t) => have.has(t))) return true;
  }
  return false;
}

/**
 * Conservative similarity rule. A candidate is accepted only if
 *  - brand known:   its brand list contains the wanted brand (all tokens), AND
 *                   >= 60% of the query name tokens appear in the candidate name and >= 40% of the candidate's
 *                   name tokens are explained by the query (brand tokens ignored on both sides)
 *  - brand unknown: >= 80% / >= 60% on the same measures and at least 2 shared tokens
 * The best score wins; anything else yields null (and the UI says "No community data found").
 */
export function matchProduct<T extends { code: string; name: string; brand: string }>(query: MatchQuery, candidates: T[]): MatchResult<T> {
  const brand = (query.brand ?? "").trim();
  const brandTokens = new Set(tokenize(brand));
  const q = tokenize(query.productName).filter((t) => !brandTokens.has(t));
  if (q.length === 0) return null;
  const qSet = new Set(q);

  let best: MatchResult<T> = null;
  for (const c of candidates) {
    if (!c || !/^\d{4,20}$/.test(c.code) || !c.name) continue;
    if (brand && !brandMatches(brand, c.brand)) continue;
    const cBrandTokens = new Set(tokenize(c.brand));
    const cTokens = tokenize(c.name).filter((t) => !brandTokens.has(t) && !cBrandTokens.has(t));
    if (cTokens.length === 0) continue;
    const cSet = new Set(cTokens);
    let shared = 0;
    qSet.forEach((t) => cSet.has(t) && shared++);
    const coverage = shared / qSet.size;
    const precision = shared / cSet.size;
    const minCoverage = brand ? 0.6 : 0.8;
    const minPrecision = brand ? 0.4 : 0.6;
    if (shared < 1 || (!brand && shared < 2 && qSet.size > 1) || coverage < minCoverage || precision < minPrecision) continue;
    if (!brand && qSet.size === 1 && cSet.size !== 1) continue; // single generic word without a brand: only an exact name
    const score = coverage + precision + (brand ? 0.5 : 0);
    if (!best || score > best.score) best = { candidate: c, score };
  }
  return best;
}

// ---------------------------------------------------------------- Open Prices parsing

export type PriceItem = {
  amount: number;
  currency: string;
  date: string; // YYYY-MM-DD
  locationName: string;
  country: string; // ISO code when known, else ""
  countryName: string;
  pricePer: string | null;
};

export function parseOpenPrices(data: unknown, now: number = Date.now()): PriceItem[] {
  const out: PriceItem[] = [];
  for (const it of arr(rec(data).items)) {
    const r = rec(it);
    const amount = typeof r.price === "number" ? r.price : Number(str(r.price));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) continue;
    const currency = str(r.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const dateRaw = str(r.date);
    const ts = Date.parse(dateRaw);
    if (!dateRaw || !Number.isFinite(ts) || ts > now + DAY_MS) continue;
    const loc = rec(r.location);
    const locationName =
      str(loc.osm_name) || str(loc.name) || str(loc.osm_display_name) || str(r.location_osm_name) || str(r.location_name);
    const country = (str(loc.osm_address_country_code) || str(loc.country_code) || str(r.location_osm_address_country_code)).toUpperCase();
    const countryName = str(loc.osm_address_country) || str(loc.country) || str(r.location_osm_address_country);
    const per = str(r.price_per).toLowerCase();
    out.push({
      amount,
      currency,
      date: new Date(ts).toISOString().slice(0, 10),
      locationName: locationName.slice(0, 120),
      country: /^[A-Z]{2}$/.test(country) ? country : "",
      countryName: countryName.slice(0, 80),
      pricePer: per ? per.slice(0, 20) : null,
    });
  }
  return out;
}

export type PriceSummary = {
  amount: number;
  currency: string;
  date: string;
  locationName: string;
  country: string;
  sourceUrl: string;
  count: number;
  min: number;
  max: number;
  pricePer: string | null;
  stale: boolean;
};

/**
 * Newest price (preferring the user's country when any price there exists), with min/max/count over the prices in
 * the SAME currency within PRICE_WINDOW_DAYS of it. Currencies are never converted.
 */
export function summarizePrices(items: PriceItem[], opts: { code: string; country?: Country | null; sourceUrl: string; now?: number }): PriceSummary | null {
  const now = opts.now ?? Date.now();
  const inCountry = opts.country
    ? items.filter((i) => i.country === opts.country!.code || (!i.country && i.countryName.toLowerCase() === opts.country!.name.toLowerCase()))
    : [];
  const pool = inCountry.length > 0 ? inCountry : items;
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const latest = sorted[0];
  const latestTs = Date.parse(latest.date);
  const group = sorted.filter(
    (i) => i.currency === latest.currency && (i.pricePer ?? "") === (latest.pricePer ?? "") && latestTs - Date.parse(i.date) <= PRICE_WINDOW_DAYS * DAY_MS,
  );
  const amounts = group.map((i) => i.amount);
  return {
    amount: latest.amount,
    currency: latest.currency,
    date: latest.date,
    locationName: latest.locationName,
    country: latest.country || latest.countryName,
    sourceUrl: opts.sourceUrl,
    count: group.length,
    min: Math.min(...amounts),
    max: Math.max(...amounts),
    pricePer: latest.pricePer,
    stale: now - latestTs > STALE_AFTER_DAYS * DAY_MS,
  };
}

// ---------------------------------------------------------------- cache

export class TtlLru<T> {
  private map = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private opts: { enabled: boolean; ttlMs: number; maxEntries: number },
    private now: () => number = Date.now,
  ) {}
  configure(opts: Partial<{ enabled: boolean; ttlMs: number; maxEntries: number }>) {
    this.opts = { ...this.opts, ...opts };
    this.map.clear();
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
  get(key: string): T | undefined {
    if (!this.opts.enabled) return undefined;
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: T) {
    if (!this.opts.enabled || this.opts.ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.opts.ttlMs });
    while (this.map.size > this.opts.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export function cacheDefaults() {
  const rawTtl = (process.env.ALT_MARKET_CACHE_TTL_SECONDS ?? "").trim();
  const ttl = rawTtl === "" ? NaN : Number(rawTtl); // an empty variable is "unset", not 0 (which would disable the cache)
  return {
    // Same switch as the OFF barcode cache; also off under vitest so tests never see stale entries.
    enabled: process.env.OFF_CACHE_DISABLED !== "true" && process.env.NODE_ENV !== "test",
    ttlMs: (Number.isFinite(ttl) && ttl >= 0 ? ttl : 6 * 60 * 60) * 1000,
    maxEntries: 500,
  };
}

export const searchCache = new TtlLru<OffCandidate[]>(cacheDefaults());
export const pricesCache = new TtlLru<PriceItem[]>(cacheDefaults());

// ---------------------------------------------------------------- outbound fetch (safe)

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }
}

const fetchGate = new Semaphore(MAX_PARALLEL_FETCHES);
export const fetchStats = { inFlight: 0, maxInFlight: 0 };

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new MarketUnavailableError("response too large");
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new MarketUnavailableError("response too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MarketUnavailableError("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET JSON from one of the two configured hosts only: scheme + origin checked, no redirects, timeout, size cap, max 3 in flight. */
export async function fetchJsonFrom(base: string, pathAndQuery: string): Promise<unknown> {
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") throw new MarketUnavailableError("bad scheme");
  if (!pathAndQuery.startsWith("/")) throw new MarketUnavailableError("bad path");
  if (pathAndQuery.startsWith("//") || pathAndQuery.includes("\\")) throw new MarketUnavailableError("host not allowed");
  const url = new URL(base.replace(/\/+$/, "") + pathAndQuery);
  if (url.origin !== baseUrl.origin) throw new MarketUnavailableError("host not allowed");
  return fetchGate.run(async () => {
    fetchStats.inFlight++;
    fetchStats.maxInFlight = Math.max(fetchStats.maxInFlight, fetchStats.inFlight);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": "IngreScanAI/1.0 (alternatives market data)", Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (err) {
        throw new MarketUnavailableError("request failed", err);
      }
      if (!res.ok) throw new MarketUnavailableError(`HTTP ${res.status}`);
      const text = await readCapped(res);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new MarketUnavailableError("invalid JSON", err);
      }
    } finally {
      fetchStats.inFlight--;
    }
  });
}

// ---------------------------------------------------------------- lookups

const OFF_FIELDS = "code,product_name,product_name_en,generic_name,brands,stores,stores_tags,countries_tags,nutriscore_grade,image_front_small_url";

export async function searchOff(query: string, country: Country | null): Promise<OffCandidate[]> {
  const base = getOffBaseUrl();
  const key = `${base}|${country?.code ?? "world"}|${query.toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "15",
    fields: OFF_FIELDS,
  });
  if (country) {
    params.set("tagtype_0", "countries");
    params.set("tag_contains_0", "contains");
    params.set("tag_0", country.name.toLowerCase());
  }
  const data = await fetchJsonFrom(base, `/cgi/search.pl?${params}`);
  const result = parseOffSearch(data);
  searchCache.set(key, result);
  return result;
}

export async function fetchPrices(code: string): Promise<PriceItem[]> {
  if (!/^\d{4,20}$/.test(code)) return [];
  const base = getOpenPricesBaseUrl();
  const key = `${base}|${code}`;
  const cached = pricesCache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({ product_code: code, order_by: "-date", size: "20" });
  const data = await fetchJsonFrom(base, `/api/v1/prices?${params}`);
  const result = parseOpenPrices(data);
  pricesCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------- per-alternative result

export type AlternativeMarketResult = {
  alternativeId: number;
  status: "ok" | "no_match" | "unavailable";
  match: { code: string; name: string; brand: string; url: string; image: string | null; nutriscore: string | null } | null;
  availability: { stores: string[]; countries: string[] };
  price: PriceSummary | null;
  /** "none" = looked up, no community prices; "unavailable" = the price service failed. */
  priceStatus: "ok" | "none" | "unavailable";
};

const empty = (alternativeId: number, status: AlternativeMarketResult["status"]): AlternativeMarketResult => ({
  alternativeId,
  status,
  match: null,
  availability: { stores: [], countries: [] },
  price: null,
  priceStatus: "none",
});

export async function lookupAlternativeMarket(
  alt: { id: number; productName: string; brand?: string | null },
  country: Country | null,
): Promise<AlternativeMarketResult> {
  try {
    const brand = (alt.brand ?? "").trim();
    const query = `${brand} ${alt.productName}`.replace(/\s+/g, " ").trim().slice(0, 150);
    if (!query) return empty(alt.id, "no_match");
    const candidates = await searchOff(query, country);
    const hit = matchProduct({ productName: alt.productName, brand }, candidates);
    if (!hit) return empty(alt.id, "no_match");
    const c = hit.candidate;
    const offUrl = `${getOffBaseUrl()}/product/${c.code}`;
    const pricesUrl = `${getOpenPricesBaseUrl()}/products/${c.code}`;

    let items: PriceItem[] = [];
    let priceStatus: AlternativeMarketResult["priceStatus"] = "ok";
    try {
      items = await fetchPrices(c.code);
    } catch {
      priceStatus = "unavailable";
    }
    const price = summarizePrices(items, { code: c.code, country, sourceUrl: pricesUrl });
    if (priceStatus === "ok" && !price) priceStatus = "none";

    // Stores: OFF "stores" plus the places where community prices were recorded (both real, both community data).
    const stores = splitList([...c.stores, ...items.map((i) => i.locationName)]).slice(0, 10);
    return {
      alternativeId: alt.id,
      status: "ok",
      match: { code: c.code, name: c.name, brand: c.brand, url: offUrl, image: c.image, nutriscore: c.nutriscore },
      availability: { stores, countries: c.countries.slice(0, 10) },
      price,
      priceStatus,
    };
  } catch (err) {
    console.error("[AltMarket] lookup failed:", err instanceof Error ? err.message : err);
    return empty(alt.id, "unavailable");
  }
}

// ---------------------------------------------------------------- per-user rate limit

const rateHits = new Map<number, { count: number; resetAt: number }>();
export const ALT_MARKET_RATE = { windowMs: 60_000, max: 20 };

/** Returns true when allowed. Fixed window, in-memory, per user id. */
export function allowAltMarketCall(userId: number, now: number = Date.now()): boolean {
  if (rateHits.size > 10_000) rateHits.forEach((v, k) => v.resetAt <= now && rateHits.delete(k));
  let e = rateHits.get(userId);
  if (!e || e.resetAt <= now) {
    e = { count: 0, resetAt: now + ALT_MARKET_RATE.windowMs };
    rateHits.set(userId, e);
  }
  e.count++;
  return e.count <= ALT_MARKET_RATE.max;
}
export function resetAltMarketRate() {
  rateHits.clear();
}

export const ALT_MARKET_ATTRIBUTION =
  "Product data from Open Food Facts (ODbL); prices from Open Prices (ODbL / CC BY), community-reported, may be outdated.";
