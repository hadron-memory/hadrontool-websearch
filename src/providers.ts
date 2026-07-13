/**
 * The provider registry — the tool's fixed allowlist (spec cor:web:020:02).
 *
 * A request names a PROVIDER slug, never a URL. Each adapter owns a single,
 * hard-coded endpoint plus the mapping from the generic, provider-agnostic
 * input (query + count/freshness/locale) to that provider's query parameters,
 * and the normalization of its response into the canonical result reference.
 * Because the destination is one of these constants — never caller-supplied —
 * this surface carries a materially lower SSRF risk than the fetch surface and
 * needs none of its connection-pinning apparatus.
 *
 * The provider CREDENTIAL is not here; it arrives inline per request (see
 * auth.ts) and is attached generically. An adapter only maps parameters and
 * parses results.
 *
 * Adding a provider is additive and must not change the normalized envelope
 * (spec cor:web:020:01) — callers never learn which adapter answered.
 */

export type Freshness = 'day' | 'week' | 'month' | 'year';

/** The generic input an adapter maps; `count` is the caller's request, pre-clamp. */
export interface GenericSearchInput {
  query: string;
  count: number;
  freshness?: Freshness;
  locale?: string;
}

/** A single raw result, pre-ranking; the engine adds the 1-based rank. */
export interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ProviderAdapter {
  slug: string;
  /** Provider's own maximum results per query — count is clamped to this. */
  maxResults: number;
  /** Full GET URL (endpoint + encoded query params) for the generic input. */
  buildUrl(input: GenericSearchInput): string;
  /** Non-credential request headers this provider needs (e.g. Accept). */
  headers(): Record<string, string>;
  /** Extract raw results from parsed provider JSON. Defensive: [] on unexpected shape. */
  parse(json: unknown): RawResult[];
}

/** Split an IETF-ish locale ('en-US') into lowercase language + uppercase region. */
function splitLocale(locale: string | undefined): { lang?: string; region?: string } {
  if (!locale) return {};
  const [lang, region] = locale.split('-');
  return { lang: lang?.toLowerCase() || undefined, region: region?.toUpperCase() || undefined };
}

/** Read `obj[key]` as a trimmed string, or '' when absent/non-string. */
function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Walk `json.a.b` defensively, returning the array at the path or [] otherwise. */
function arrayAt(json: unknown, ...path: string[]): Record<string, unknown>[] {
  let cur: unknown = json;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return [];
    cur = (cur as Record<string, unknown>)[key];
  }
  return Array.isArray(cur) ? (cur.filter((e) => e != null && typeof e === 'object') as Record<string, unknown>[]) : [];
}

const BRAVE_FRESHNESS: Record<Freshness, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

const brave: ProviderAdapter = {
  slug: 'brave',
  maxResults: 20,
  headers: () => ({ accept: 'application/json' }),
  buildUrl(input) {
    const p = new URLSearchParams({ q: input.query, count: String(input.count) });
    if (input.freshness) p.set('freshness', BRAVE_FRESHNESS[input.freshness]);
    const { lang, region } = splitLocale(input.locale);
    if (region) p.set('country', region);
    if (lang) p.set('search_lang', lang);
    return `https://api.search.brave.com/res/v1/web/search?${p.toString()}`;
  },
  parse(json) {
    return arrayAt(json, 'web', 'results').map((r) => ({
      title: str(r, 'title'),
      url: str(r, 'url'),
      snippet: str(r, 'description'),
    }));
  },
};

// Bing has no 'year' freshness; a year request omits the filter (broadest).
const BING_FRESHNESS: Record<Freshness, string | undefined> = { day: 'Day', week: 'Week', month: 'Month', year: undefined };

const bing: ProviderAdapter = {
  slug: 'bing',
  maxResults: 50,
  headers: () => ({ accept: 'application/json' }),
  buildUrl(input) {
    const p = new URLSearchParams({ q: input.query, count: String(input.count), responseFilter: 'Webpages' });
    if (input.freshness && BING_FRESHNESS[input.freshness]) p.set('freshness', BING_FRESHNESS[input.freshness]!);
    if (input.locale) p.set('mkt', input.locale);
    return `https://api.bing.microsoft.com/v7.0/search?${p.toString()}`;
  },
  parse(json) {
    return arrayAt(json, 'webPages', 'value').map((r) => ({
      title: str(r, 'name'),
      url: str(r, 'url'),
      snippet: str(r, 'snippet'),
    }));
  },
};

/** The frozen allowlist. Keys are the provider slugs a request may name. */
export const PROVIDERS: Record<string, ProviderAdapter> = { brave, bing };

/** Provider used when a request names none (single-provider deployments). */
export const DEFAULT_PROVIDER = 'brave';

/** Resolve a slug (or the default) to an adapter, or undefined if not on the allowlist. */
export function resolveProvider(slug: string | undefined): ProviderAdapter | undefined {
  return PROVIDERS[slug ?? DEFAULT_PROVIDER];
}
