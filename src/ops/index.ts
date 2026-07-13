/**
 * The operation registry — the hadron-server#647 contract surface.
 *
 * `POST /ops/search`; the single operation has ONE zod schema (defineOp parses
 * before the handler runs — no shadow schema to drift from the declared
 * contract). The tool is stateless: a search is a GET-idempotent read, so retry
 * is safe, but the tool holds nothing between calls.
 *
 * The response envelope is the normalized, versioned contract (spec
 * cor:web:020:01): `{ results: [{title,url,snippet,rank}], contractVersion,
 * source: 'external' }`. Results are untrusted external input — `source`
 * carries that so hadron-server's framing wraps them.
 */

import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { authSchema } from '../auth.js';
import { CONTRACT_VERSION, performSearch, type SearchDeps } from '../search.js';

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  schema: z.ZodType;
  run(deps: SearchDeps, input: Record<string, unknown>): Promise<unknown>;
}

function defineOp<S extends z.ZodType>(
  schema: S,
  handler: (deps: SearchDeps, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    schema,
    run: (deps, raw) => handler(deps, schema.parse(raw)),
  };
}

const searchSchema = z
  .object({
    /** Contract version the caller depends on; validated against what this tool speaks. */
    version: z.string().max(64).optional(),
    /** Provider slug the tool resolves from its allowlist; the default is used when absent. */
    provider: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/, 'invalid provider slug')
      .optional(),
    query: z.string().min(1).max(1_000),
    // Accept a generous range and CLAMP in the engine — the contract says the
    // tool clamps to its own maximum, so an over-large count is not an error.
    count: z.number().int().positive().max(100).optional(),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
    locale: z
      .string()
      .regex(/^[A-Za-z]{2}(-[A-Za-z]{2})?$/, 'invalid locale (expected e.g. "en" or "en-US")')
      .optional(),
    /** Opaque provider knobs — accepted, and safely ignored when unknown (spec cor:web:020:01). */
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    auth: authSchema.optional(),
  })
  .strict();

const search = defineOp(searchSchema, async (deps, input) => {
  // Versioning: reject a contract version this tool does not implement, rather
  // than silently answering with a shape the caller may not expect.
  if (input.version && input.version !== CONTRACT_VERSION) {
    throw new ValidationError(
      'version',
      `unsupported contract version "${input.version}"; this tool speaks ${CONTRACT_VERSION}`,
    );
  }
  return performSearch(
    {
      provider: input.provider,
      query: input.query,
      count: input.count,
      freshness: input.freshness,
      locale: input.locale,
      auth: input.auth,
      // providerOptions is intentionally not forwarded: these adapters honor no
      // provider-specific knobs, and the contract requires unknown ones be ignored.
    },
    deps,
  );
});

export const OPERATIONS: Record<string, OperationDef> = { search };

export async function runOperation(deps: SearchDeps, name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = OPERATIONS[name];
  if (!def) throw new ValidationError('operation', `unknown operation "${name}"`);
  return def.run(deps, input);
}
