import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration, validated once at boot. Importing this module
 * throws (and the process exits non-zero) if the environment is invalid, so a
 * misconfigured container fails fast instead of half-working.
 *
 * This tool is a STATELESS conduit (spec cor:web:020:00): it holds no provider
 * keys. The provider credential arrives inline per request (`auth`), sourced by
 * hadron-server (spec cor:web:020:02). The only infra secret here is the shared
 * bearer that gates the internal ops plane.
 */
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  WEBSEARCH_TOOL_TOKEN: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';

// Refuse to run an unauthenticated search proxy in production — an open
// endpoint inside the private network is an egress foothold, and it would
// forward whatever provider credential a caller supplies.
if (isProduction && !env.WEBSEARCH_TOOL_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('WEBSEARCH_TOOL_TOKEN must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}

export const VERSION = '0.1.0';

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction,
  port: env.PORT,
  /** Shared bearer token; when undefined, auth is disabled (dev only). */
  serviceToken: env.WEBSEARCH_TOOL_TOKEN,
} as const;

export type Config = typeof config;
