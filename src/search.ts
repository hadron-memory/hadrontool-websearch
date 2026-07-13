/**
 * The search engine — guard-free, fixed-allowlist egress (spec cor:web:020:02).
 *
 * A single GET to an allowlisted provider endpoint under one timeout budget
 * that also covers the body read, then defensive normalization into the
 * canonical envelope. Unlike the fetch surface there is NO SSRF guard and NO
 * connection pinning: the destination is one of the provider registry's fixed
 * constants, never caller-supplied, so the DNS-rebinding / private-address
 * threat that pinning defends against does not exist here. The query is
 * caller-controlled data, but it is a URL-encoded PARAMETER to a fixed endpoint,
 * never the destination.
 *
 * Provider responses are untrusted: malformed JSON or an unexpected shape
 * DEGRADES to an empty result list, it never crashes the request.
 *
 * The fetch is injected (`SearchDeps`) so the test suite runs with no network.
 */

import { fetch as undiciFetch } from 'undici';
import { buildAuthHeader, type AuthSpec } from './auth.js';
import {
  ProviderNotConfiguredError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderUnauthorizedError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from './errors.js';
import { resolveProvider, type Freshness, type RawResult } from './providers.js';

/** The contract version this tool implements (spec cor:web:020:01). */
export const CONTRACT_VERSION = 'web-search@1';
export const DEFAULT_COUNT = 10;
/** Tool-wide result cap; each provider's own maximum may clamp it further. */
export const MAX_COUNT = 20;
export const SEARCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const USER_AGENT = 'hadrontool-websearch/0.1 (+https://hadronmemory.com)';

/** Structural response shape — satisfied by undici's fetch Response. */
export interface SearchFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type SearchFetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<SearchFetchResponse>;

/** The injectable seam — production default below, fakes in tests. */
export interface SearchDeps {
  fetchImpl: SearchFetchImpl;
}

export const defaultDeps: SearchDeps = {
  fetchImpl: (url, init) => undiciFetch(url, init) as unknown as Promise<SearchFetchResponse>,
};

export interface SearchRequest {
  provider?: string;
  query: string;
  count?: number;
  freshness?: Freshness;
  locale?: string;
  auth?: AuthSpec;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 1-based position in the ordered list. */
  rank: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  contractVersion: string;
  source: 'external';
}

/** Run one guarded-by-allowlist search and normalize the provider response. */
export async function performSearch(req: SearchRequest, deps: SearchDeps = defaultDeps): Promise<SearchOutcome> {
  const adapter = resolveProvider(req.provider);
  if (!adapter) throw new ProviderNotConfiguredError(req.provider);

  const count = Math.min(req.count ?? DEFAULT_COUNT, adapter.maxResults, MAX_COUNT);
  const url = adapter.buildUrl({ query: req.query, count, freshness: req.freshness, locale: req.locale });
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    ...adapter.headers(),
    // The inline credential attaches ONLY to the provider request.
    ...(req.auth ? buildAuthHeader(req.auth) : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    let res: SearchFetchResponse;
    try {
      res = await deps.fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamTimeoutError(adapter.slug, SEARCH_TIMEOUT_MS / 1000);
      throw new UpstreamUnreachableError(adapter.slug, String((err as Error)?.message ?? err));
    }

    // Classify by status before reading the body.
    const status = res.status;
    if (status === 401 || status === 403) throw new ProviderUnauthorizedError(adapter.slug);
    if (status === 429) {
      const ra = parseInt(res.headers.get('retry-after') ?? '', 10);
      throw new ProviderRateLimitedError(adapter.slug, Number.isFinite(ra) ? ra : undefined);
    }
    if (status >= 500) throw new UpstreamUnreachableError(adapter.slug, `status ${status}`);
    if (status >= 400) throw new ProviderRejectedError(adapter.slug, status);

    const declaredLength = parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new UpstreamUnreachableError(adapter.slug, 'response too large');
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamTimeoutError(adapter.slug, SEARCH_TIMEOUT_MS / 1000);
      throw new UpstreamUnreachableError(adapter.slug, 'failed reading the provider response');
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new UpstreamUnreachableError(adapter.slug, 'response too large');

    // Untrusted provider output: malformed JSON or an unexpected shape degrades
    // to no results rather than throwing (spec cor:web:020:00, degrade-never-crash).
    let raw: RawResult[] = [];
    try {
      raw = adapter.parse(JSON.parse(text));
    } catch {
      raw = [];
    }

    const results: SearchResult[] = raw
      .filter((r) => r.url) // a reference without a URL is not usable
      .slice(0, count)
      .map((r, i) => ({ title: r.title, url: r.url, snippet: r.snippet, rank: i + 1 }));

    return { results, contractVersion: CONTRACT_VERSION, source: 'external' };
  } finally {
    clearTimeout(timer);
  }
}
