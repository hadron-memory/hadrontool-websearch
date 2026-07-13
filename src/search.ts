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
  body: ReadableStream<Uint8Array> | null;
}

export type SearchFetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal },
) => Promise<SearchFetchResponse>;

/** The injectable seam — production default below, fakes in tests. */
export interface SearchDeps {
  fetchImpl: SearchFetchImpl;
}

export const defaultDeps: SearchDeps = {
  fetchImpl: (url, init) =>
    undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      // Do NOT follow redirects. The guard-free posture rests entirely on the
      // destination being an allowlisted host; a 30x would send us to an
      // arbitrary Location off the allowlist. Manual mode returns the 3xx so
      // performSearch can refuse it (spec cor:web:020:02).
      redirect: init.redirect,
      signal: init.signal,
    }) as unknown as Promise<SearchFetchResponse>,
};

/**
 * Read the body under a hard byte cap. A trusted search API never returns a
 * body this large, so exceeding the cap is an anomaly: we flag it (the caller
 * rejects) rather than parse a truncated JSON, and we never buffer past the
 * budget — closing the OOM window that `res.text()` on a Content-Length-less /
 * chunked response would leave open. An abort surfaces as a reader rejection.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return { text: '', truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated: false };
}

/** A result reference is only usable if it is an absolute http(s) URL. */
function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

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
      res = await deps.fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamTimeoutError(adapter.slug, SEARCH_TIMEOUT_MS / 1000);
      throw new UpstreamUnreachableError(adapter.slug, String((err as Error)?.message ?? err));
    }

    // Classify by status before reading the body.
    const status = res.status;
    if (status >= 300 && status < 400) {
      // The provider tried to redirect off its fixed endpoint. Following it
      // would leave the allowlist — the one thing the guard-free egress must
      // never do — so we refuse rather than chase the Location.
      throw new UpstreamUnreachableError(adapter.slug, 'provider attempted a redirect off the fixed endpoint');
    }
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

    let read: { text: string; truncated: boolean };
    try {
      read = await readCapped(res.body, MAX_RESPONSE_BYTES);
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamTimeoutError(adapter.slug, SEARCH_TIMEOUT_MS / 1000);
      throw new UpstreamUnreachableError(adapter.slug, 'failed reading the provider response');
    }
    if (read.truncated) throw new UpstreamUnreachableError(adapter.slug, 'response too large');

    // Untrusted provider output: malformed JSON or an unexpected shape degrades
    // to no results rather than throwing (spec cor:web:020:00, degrade-never-crash).
    let raw: RawResult[] = [];
    try {
      raw = adapter.parse(JSON.parse(read.text));
    } catch {
      raw = [];
    }

    const results: SearchResult[] = raw
      // A reference is only usable if it is an absolute http(s) URL — drop
      // relative URLs and dangerous schemes (javascript:/data:/file:) a
      // provider might return.
      .filter((r) => isHttpUrl(r.url))
      .slice(0, count)
      .map((r, i) => ({ title: r.title, url: r.url, snippet: r.snippet, rank: i + 1 }));

    return { results, contractVersion: CONTRACT_VERSION, source: 'external' };
  } finally {
    clearTimeout(timer);
  }
}
