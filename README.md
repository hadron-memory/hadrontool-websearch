# hadrontool-websearch

Stateless web **search** capability tool for the
[Hadron Memory](https://hadronmemory.com/) platform. It gives headless LLM runs
a governed way to query an external search provider and get back a ranked list
of result references (title, URL, snippet) — behind a fixed provider allowlist,
with the provider credential supplied inline per request.

Design and decisions: hadron-server#647 (core-side spine merged in
hadron-server#648). This is a *separate* capability from
[`hadrontool-webfetch`](https://github.com/hadron-memory/hadrontool-webfetch),
delivered by a *separate* stateless tool — not a mode of fetch. It is the
reference implementation of the versioned, provider-agnostic **`web-search@1`**
contract (platform specs `cor:web:020*`), so a conforming third-party tool can
be swapped in with no caller change. **All authorization happens in
hadron-server** before a request reaches this service.

## Operation

`POST /ops/search` (bearer-gated, JSON in/out).

**Request** — the normalized contract (`cor:web:020:01`):

```jsonc
{
  "version": "web-search@1",   // optional; rejected if not what this tool speaks
  "provider": "brave",          // optional; a slug from the allowlist (default: brave)
  "query": "red pandas",        // required
  "count": 10,                  // optional; clamped to the tool/provider maximum
  "freshness": "week",          // optional: day | week | month | year
  "locale": "en-US",            // optional
  "providerOptions": {},         // optional, opaque; unknown keys safely ignored
  "auth": { "type": "header", "name": "X-Subscription-Token", "value": "…" }
}
```

**Response**:

```jsonc
{
  "ok": true,
  "results": [{ "title": "…", "url": "https://…", "snippet": "…", "rank": 1 }],
  "contractVersion": "web-search@1",
  "source": "external"          // results are untrusted external input
}
```

Errors use a stable typed catalog (passed through by hadron-server's
`webSearchClient` as `extensions.webSearchErrorCode`): `validation_error`,
`provider_not_configured`, `provider_unauthorized`, `provider_rejected`,
`provider_rate_limited`, `upstream_unreachable`, `upstream_timeout`.

Also: `GET /healthz`, `GET /readyz` (open), `GET /info` (bearer).

## Providers

The allowlist lives in [`src/providers.ts`](src/providers.ts) — one adapter per
provider (endpoint + param mapping + response normalization). Ships with
`brave` (default) and `bing`. A request names a provider *slug*, never a URL:
the destination is always one of these fixed constants, which is why this
surface needs no SSRF guard or connection pinning (spec `cor:web:020:02`). The
provider API key is **not** stored here — hadron-server sources it and passes it
inline via `auth`.

## Commands

```bash
npm run dev        # tsx watch (port 8080)
npm test           # vitest — real HTTP via supertest over a FAKE fetch seam
npm run typecheck
npm run build      # tsc -p tsconfig.build.json → dist/
```

No database, no keys at rest, nothing to set up.

## Configuration

| Var | Required | Purpose |
| --- | --- | --- |
| `WEBSEARCH_TOOL_TOKEN` | prod | Shared bearer for the internal `/ops` plane. Boot refuses to start without it when `NODE_ENV=production`. |
| `PORT` | no | Listen port (default 8080). |
| `NODE_ENV` | no | `production` enables the bearer requirement. |

Provider selection and the provider API key are **core-sourced** and travel in
the request body (`provider` + `auth`); they are not tool configuration.
