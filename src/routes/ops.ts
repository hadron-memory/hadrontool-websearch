/**
 * Operations plane — POST /ops/<operation> (internal, bearer-gated).
 *
 * Every response is JSON. Errors use the typed catalog (src/errors.ts) —
 * hadron-server's webSearchClient passes the `error` code through verbatim as
 * `extensions.webSearchErrorCode`. The tool is stateless: there is no
 * idempotency plane; a search is a GET-idempotent read the caller may retry.
 */

import { Router, type Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { WebsearchToolError, validationFromZod } from '../errors.js';
import { OPERATIONS, runOperation } from '../ops/index.js';
import type { SearchDeps } from '../search.js';

function respondWithError(res: Response, err: unknown, opName: string): void {
  const typed = err instanceof ZodError ? validationFromZod(err) : err;
  if (typed instanceof WebsearchToolError) {
    res.status(typed.httpStatus).json(typed.toBody());
    return;
  }
  // Log the error class + a short message only — never inputs, headers, or
  // bodies (search inputs carry the caller-supplied provider credential + query).
  logger.error('operation failed', {
    op: opName,
    err: String((typed as Error)?.message ?? typed).slice(0, 200),
  });
  res.status(500).json({ error: 'internal_error', message: 'Unexpected error.' });
}

/** Build the /ops router over injected search deps (tests inject fakes). */
export function opsRouter(deps: SearchDeps): Router {
  const router = Router();

  router.post('/:operation', async (req, res) => {
    const name = req.params.operation;
    if (!OPERATIONS[name]) {
      res.status(404).json({
        error: 'unknown_operation',
        message: `No operation "${name}"`,
        operations: Object.keys(OPERATIONS),
      });
      return;
    }
    try {
      const result = await runOperation(deps, name, (req.body ?? {}) as Record<string, unknown>);
      res.status(200).json({ ok: true, ...(result as Record<string, unknown>) });
    } catch (err) {
      respondWithError(res, err, name);
    }
  });

  return router;
}
