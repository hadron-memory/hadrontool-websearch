import { afterEach, describe, expect, it, vi } from 'vitest';
import { performSearch, MAX_COUNT, type SearchDeps, type SearchFetchResponse } from './search.js';
import { WebsearchToolError } from './errors.js';

function streamFrom(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

function fakeResponse(opts: { status?: number; body?: unknown; headers?: Record<string, string> }): SearchFetchResponse {
  const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {});
  return {
    status: opts.status ?? 200,
    headers: { get: (n) => headers.get(n.toLowerCase()) ?? null },
    body: streamFrom(bodyStr),
  };
}

/** A deps whose fetch records the call and returns a canned response. */
function depsReturning(res: SearchFetchResponse): { deps: SearchDeps; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    deps: {
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return res;
      },
    },
  };
}

const braveBody = {
  web: { results: Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, url: `https://x/${i}`, description: `d${i}` })) },
};

afterEach(() => vi.useRealTimers());

describe('performSearch', () => {
  it('normalizes provider results into the ranked envelope tagged external', async () => {
    const { deps } = depsReturning(fakeResponse({ body: { web: { results: [{ title: 'A', url: 'https://a', description: 'da' }] } } }));
    const out = await performSearch({ query: 'q', auth: { type: 'header', name: 'X-Subscription-Token', value: 'k' } }, deps);
    expect(out).toEqual({
      results: [{ title: 'A', url: 'https://a', snippet: 'da', rank: 1 }],
      contractVersion: 'web-search@1',
      source: 'external',
    });
  });

  it('clamps count to the tool/provider maximum and slices results', async () => {
    const { deps, calls } = depsReturning(fakeResponse({ body: braveBody }));
    const out = await performSearch({ query: 'q', count: 100 }, deps);
    expect(out.results).toHaveLength(MAX_COUNT);
    expect(out.results[MAX_COUNT - 1].rank).toBe(MAX_COUNT);
    expect(new URL(calls[0].url).searchParams.get('count')).toBe(String(MAX_COUNT));
  });

  it('attaches the inline credential only to the provider request', async () => {
    const { deps, calls } = depsReturning(fakeResponse({ body: { web: { results: [] } } }));
    await performSearch({ query: 'q', auth: { type: 'bearer', token: 't' } }, deps);
    expect(calls[0].headers.authorization).toBe('Bearer t');
  });

  it('degrades to no results on malformed JSON (never crashes)', async () => {
    const { deps } = depsReturning(fakeResponse({ body: 'this is not json' }));
    const out = await performSearch({ query: 'q' }, deps);
    expect(out.results).toEqual([]);
  });

  it('refuses a provider redirect rather than following it off the allowlist', async () => {
    const { deps } = depsReturning(fakeResponse({ status: 302, headers: { location: 'https://evil.example/x' } }));
    await expect(performSearch({ query: 'q' }, deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('drops results whose URL is not an absolute http(s) URL', async () => {
    const body = {
      web: {
        results: [
          { title: 'ok', url: 'https://ok', description: 'd' },
          { title: 'js', url: 'javascript:alert(1)', description: 'd' },
          { title: 'rel', url: '/relative', description: 'd' },
        ],
      },
    };
    const { deps } = depsReturning(fakeResponse({ body }));
    const out = await performSearch({ query: 'q' }, deps);
    expect(out.results.map((r) => r.url)).toEqual(['https://ok']);
  });

  it('maps an unknown provider to provider_not_configured', async () => {
    const { deps } = depsReturning(fakeResponse({ body: {} }));
    await expect(performSearch({ query: 'q', provider: 'nope' }, deps)).rejects.toMatchObject({ code: 'provider_not_configured' });
  });

  it.each([
    [401, 'provider_unauthorized'],
    [403, 'provider_unauthorized'],
    [429, 'provider_rate_limited'],
    [400, 'provider_rejected'],
    [500, 'upstream_unreachable'],
  ])('maps provider HTTP %i to %s', async (status, code) => {
    const { deps } = depsReturning(fakeResponse({ status }));
    const err = await performSearch({ query: 'q' }, deps).catch((e) => e);
    expect(err).toBeInstanceOf(WebsearchToolError);
    expect(err.code).toBe(code);
  });

  it('maps a network failure to upstream_unreachable', async () => {
    const deps: SearchDeps = { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } };
    await expect(performSearch({ query: 'q' }, deps)).rejects.toMatchObject({ code: 'upstream_unreachable' });
  });

  it('maps a timed-out provider to upstream_timeout', async () => {
    vi.useFakeTimers();
    // A fetch that only settles when the abort signal fires.
    const deps: SearchDeps = {
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    };
    const p = performSearch({ query: 'q' }, deps).catch((e) => e);
    await vi.advanceTimersByTimeAsync(11_000);
    const err = await p;
    expect(err).toBeInstanceOf(WebsearchToolError);
    expect(err.code).toBe('upstream_timeout');
  });
});
