# Agent dev guide — hadrontool-websearch

**hadrontool-websearch** is an independently-deployed, **stateless** web
**search** capability tool for the Hadron platform: it gives headless LLM runs a
governed way to query an external search provider and receive a ranked list of
result references. Core (hadron-server) keeps the contract, identity, provider
credentials, and ALL authorization; this tool executes searches and nothing
else.

**Design issue: hadron-server#647** (core-side spine merged in #648). It is the
reference implementation of the versioned, provider-agnostic **`web-search@1`**
contract — platform specs **`cor:web:020*`**. Sibling tool: `hadrontool-webfetch`
(the stateless template this repo copies); it is a *separate* capability, not a
mode of fetch.

## Commands

```bash
npm run dev          # tsx watch (port 8080)
npm test             # vitest — real HTTP via supertest over a FAKE fetch seam
npm run typecheck
npm run build        # tsc -p tsconfig.build.json
```

No database, no Prisma, no migrations, no keys at rest — nothing to set up.

## Structure

- `src/providers.ts` — the fixed provider allowlist (spec cor:web:020:02). One
  adapter per provider: hard-coded endpoint + generic-input→param mapping +
  response→`RawResult` normalization. `brave` (default) and `bing`.
- `src/search.ts` — the guard-free egress engine: one GET to an allowlisted
  endpoint under one timeout budget (covering the body read), then defensive
  normalization into `{title,url,snippet,rank}`. Injectable `SearchDeps` fetch
  seam. Status→typed-error classification.
- `src/auth.ts` — the inline credential channel (spec cor:web:020:02): the
  three provider-agnostic shapes (bearer/basic/header) → one provider request
  header. The zod schema + `buildAuthHeader`.
- `src/ops/index.ts` — the operation registry (`search`); one zod schema via
  `defineOp`; contract-version check.
- `src/routes/` — `ops` (bearer-gated internal plane), `health` (open).
- `src/errors.ts` — the stable typed error catalog (the public code surface).
- Tests inject `SearchDeps` fakes — no network, no DNS in the suite.

## Key invariants

- **Stateless.** No database, no keys, no records. The provider credential
  arrives inline per request (`auth`) — core sources it; the tool stores none.
  A search is a GET-idempotent read, so retry is safe (unlike webfetch's non-GET
  path), but the tool still holds nothing between calls.
- **All authorization happens in core.** Anonymous requests are allowed here by
  design (behind the shared bearer); the policy chain (`tool.web_search`)
  governs callers in core. Never add authorization logic to this tool.
- **Destinations are a fixed allowlist, never caller-supplied.** A request names
  a provider *slug*; the tool resolves it to a hard-coded endpoint. This is why
  there is NO SSRF guard and NO connection pinning here (spec cor:web:020:02) —
  the caller-directed SSRF threat the fetch surface faces does not exist. The
  query is a URL-encoded parameter to a fixed endpoint, never the destination.
  **Never add a provider whose endpoint host is derived from request input.**
- **The normalized envelope is the contract.** Callers depend on
  `{title,url,snippet,rank}` + `contractVersion` + `source:'external'` and NEVER
  on which provider answered (spec cor:web:020:01). Adding a provider is
  additive and must not change the envelope or leak provider identity into it.
- **Credentials never leak.** Not into logs (log codes/providers/statuses/counts
  only — never the query), not into error bodies (zod messages don't echo
  values), not into a URL (the `auth` header channel only). `authorization` and
  `cookie` cannot be set through the `header` auth shape.
- **Provider output is untrusted** — malformed JSON or an unexpected shape
  DEGRADES to an empty result list, never crashes; results are tagged
  `source:'external'` so core's framing wraps them.
- **Agent-agnostic.** No agent names in `src/` (Constitution Invariant #14).

## The core contract (must stay in lockstep with hadron-server)

- Endpoint: `POST /ops/search`. Request `{version?, provider?, query, count?,
  freshness?, locale?, providerOptions?, auth?}`; response `{ok, results,
  contractVersion, source}`.
- Error body `{error:<code>, message, …}` with the catalog codes above — core's
  `webSearchClient` passes `error` through as `extensions.webSearchErrorCode`.
- Contract version constant: `web-search@1` (`src/search.ts`). Bump additively;
  a request naming an unsupported version is a `validation_error`.

## Use of Hadron

This tool has no memory of its own — work against the shared ones:

- `hrn:memory:hadronmemory.com::dev` — findings, conventions, the
  capability-tool pattern (`capability-tool-pattern`), deploy runbook
- `hrn:memory:hadronmemory.com::specs` — product specs (`cor:web:020*` is the
  web-search capability contract this tool implements)

Query Hadron before reading code/design (`hadron_find_nodes` → `hadron_get_node`),
and capture non-obvious findings as nodes the moment they emerge.
