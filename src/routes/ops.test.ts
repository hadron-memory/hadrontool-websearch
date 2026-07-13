import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { SearchDeps, SearchFetchResponse } from '../search.js';

function streamFrom(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200): SearchFetchResponse {
  return {
    status,
    headers: { get: () => null },
    body: streamFrom(JSON.stringify(body)),
  };
}

/** App wired with a fake provider that returns one Brave-shaped result. */
function appWithResults() {
  const deps: SearchDeps = {
    fetchImpl: async () => jsonResponse({ web: { results: [{ title: 'A', url: 'https://a', description: 'da' }] } }),
  };
  return createApp({ searchDeps: deps });
}

describe('POST /ops/search', () => {
  it('returns the normalized, versioned envelope', async () => {
    const res = await request(appWithResults()).post('/ops/search').send({ version: 'web-search@1', query: 'red pandas' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      results: [{ title: 'A', url: 'https://a', snippet: 'da', rank: 1 }],
      contractVersion: 'web-search@1',
      source: 'external',
    });
  });

  it('rejects a missing query as validation_error', async () => {
    const res = await request(appWithResults()).post('/ops/search').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects an unknown top-level field (strict schema)', async () => {
    const res = await request(appWithResults()).post('/ops/search').send({ query: 'q', destination: 'https://evil' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('rejects an unsupported contract version', async () => {
    const res = await request(appWithResults()).post('/ops/search').send({ version: 'web-search@2', query: 'q' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation_error', field: 'version' });
  });

  it('maps an unknown provider to provider_not_configured', async () => {
    const res = await request(appWithResults()).post('/ops/search').send({ query: 'q', provider: 'nope' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('provider_not_configured');
  });

  it('maps a malformed JSON body to the in-catalog validation_error', async () => {
    const res = await request(appWithResults())
      .post('/ops/search')
      .set('content-type', 'application/json')
      .send('{ not json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('404s an unknown operation', async () => {
    const res = await request(appWithResults()).post('/ops/does-not-exist').send({ query: 'q' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_operation');
  });
});

describe('bearer gate', () => {
  const deps: SearchDeps = { fetchImpl: async () => jsonResponse({ web: { results: [] } }) };

  it('401s a request with no/incorrect token when a token is configured', async () => {
    const app = createApp({ searchDeps: deps, serviceToken: 'secret' });
    const res = await request(app).post('/ops/search').send({ query: 'q' });
    expect(res.status).toBe(401);
  });

  it('passes with the correct bearer token', async () => {
    const app = createApp({ searchDeps: deps, serviceToken: 'secret' });
    const res = await request(app).post('/ops/search').set('authorization', 'Bearer secret').send({ query: 'q' });
    expect(res.status).toBe(200);
  });
});

describe('health', () => {
  it('exposes open liveness/readiness', async () => {
    const app = createApp({ serviceToken: 'secret' });
    expect((await request(app).get('/healthz')).status).toBe(200);
    expect((await request(app).get('/readyz')).status).toBe(200);
  });
});
