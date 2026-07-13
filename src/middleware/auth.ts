import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

// Compare via fixed-size SHA-256 digests so the comparison is timing-safe AND
// leaks nothing about the secret's length (a bare length check on the raw
// buffers would reveal the token length through an early return).
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Bearer-token gate for the ops plane. When the token is unset (development
 * only — production boot refuses this), the gate is a pass-through.
 */
export function requireAuth(serviceToken: string | undefined) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    if (!serviceToken) {
      next();
      return;
    }
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeEqual(match[1], serviceToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
