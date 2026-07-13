/**
 * The inline credential channel (spec cor:web:020:02).
 *
 * The provider API key never lives in this tool. hadron-server sources it and
 * passes it inline per request as `auth`, in one of the three provider-agnostic
 * shapes the fetch surface also uses (bearer / basic / named header). The tool
 * turns that into a single provider request header and attaches it ONLY to the
 * provider call — never logged, never echoed in an error, never placed in a URL.
 */

import { z } from 'zod';

export type AuthSpec =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string };

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_CREDENTIAL_CHARS = 4_096;

/**
 * Characters an HTTP header value may not carry: the whole C0 control range and
 * DEL, minus HTAB (0x09). CR/LF/NUL are the classic injection shapes; rejecting
 * the rest here means they fail as `validation_error` rather than an opaque
 * socket-level throw.
 */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_INVALID_RE = /[\x00-\x08\x0a-\x1f\x7f]/;
const noControlChars = (v: string) => !HEADER_VALUE_INVALID_RE.test(v);

/**
 * Structural / connection headers a credential may never masquerade as (the
 * fetch layer owns them); `authorization` is intentionally allowed here because
 * `bearer`/`basic` build it themselves — a caller using `type: 'header'` to set
 * it directly is rejected below via this set.
 */
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'authorization',
  'cookie',
]);

export const authSchema: z.ZodType<AuthSpec> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bearer'),
      token: z.string().min(1).max(MAX_CREDENTIAL_CHARS).refine(noControlChars, 'invalid token'),
    })
    .strict(),
  z
    .object({
      type: z.literal('basic'),
      username: z.string().min(1).max(MAX_CREDENTIAL_CHARS).refine(noControlChars, 'invalid username'),
      password: z.string().min(1).max(MAX_CREDENTIAL_CHARS).refine(noControlChars, 'invalid password'),
    })
    .strict(),
  z
    .object({
      type: z.literal('header'),
      name: z
        .string()
        .regex(HEADER_NAME_RE, 'invalid header name')
        .refine((n) => !FORBIDDEN_CREDENTIAL_HEADERS.has(n.toLowerCase()), 'this header cannot carry a credential'),
      value: z.string().min(1).max(MAX_CREDENTIAL_CHARS).refine(noControlChars, 'invalid header value'),
    })
    .strict(),
]);

/** Build the single header an AuthSpec contributes to the provider request. Key is lowercase. */
export function buildAuthHeader(auth: AuthSpec): Record<string, string> {
  switch (auth.type) {
    case 'bearer':
      return { authorization: `Bearer ${auth.token}` };
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
    case 'header':
      return { [auth.name.toLowerCase()]: auth.value };
  }
}
