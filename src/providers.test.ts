import { describe, expect, it } from 'vitest';
import { PROVIDERS, resolveProvider, DEFAULT_PROVIDER } from './providers.js';

describe('resolveProvider', () => {
  it('resolves a known slug', () => {
    expect(resolveProvider('bing')?.slug).toBe('bing');
  });

  it('falls back to the default when none is named', () => {
    expect(resolveProvider(undefined)?.slug).toBe(DEFAULT_PROVIDER);
  });

  it('returns undefined for a slug not on the allowlist', () => {
    expect(resolveProvider('totally-unknown')).toBeUndefined();
  });
});

describe('brave adapter', () => {
  const brave = PROVIDERS.brave;

  it('maps query, count, freshness, and locale to Brave params against its fixed host', () => {
    const url = new URL(brave.buildUrl({ query: 'red pandas', count: 5, freshness: 'week', locale: 'en-US' }));
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('red pandas');
    expect(url.searchParams.get('count')).toBe('5');
    expect(url.searchParams.get('freshness')).toBe('pw');
    expect(url.searchParams.get('country')).toBe('US');
    expect(url.searchParams.get('search_lang')).toBe('en');
  });

  it('parses web.results into raw references', () => {
    expect(
      brave.parse({ web: { results: [{ title: 'A', url: 'https://a', description: 'da' }] } }),
    ).toEqual([{ title: 'A', url: 'https://a', snippet: 'da' }]);
  });

  it('degrades to [] on an unexpected shape', () => {
    expect(brave.parse({ nope: true })).toEqual([]);
    expect(brave.parse('garbage')).toEqual([]);
  });
});

describe('bing adapter', () => {
  const bing = PROVIDERS.bing;

  it('omits freshness for a year request (Bing has no year window)', () => {
    const url = new URL(bing.buildUrl({ query: 'q', count: 3, freshness: 'year', locale: 'en-US' }));
    expect(url.origin + url.pathname).toBe('https://api.bing.microsoft.com/v7.0/search');
    expect(url.searchParams.get('freshness')).toBeNull();
    expect(url.searchParams.get('mkt')).toBe('en-US');
  });

  it('parses webPages.value into raw references', () => {
    expect(
      bing.parse({ webPages: { value: [{ name: 'B', url: 'https://b', snippet: 'sb' }] } }),
    ).toEqual([{ title: 'B', url: 'https://b', snippet: 'sb' }]);
  });
});
