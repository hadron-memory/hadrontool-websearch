/**
 * Typed error catalog — stable public surface (hadron-server#647).
 *
 * Codes are the PUBLIC contract: hadron-server's webSearchClient passes them
 * through to GraphQL `extensions.webSearchErrorCode` verbatim, so their
 * meanings must stay stable. New codes may be added; existing ones never
 * change meaning. The response body shape is `{ error: <code>, message, ... }`
 * with the HTTP status below.
 *
 * Error messages may name the provider slug and status but must NEVER echo
 * request input wholesale — the request carries the caller-supplied provider
 * credential and the query (kept off logs/errors, spec cor:web:020:02).
 */

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class WebsearchToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** Input failed schema or semantic validation (unknown contract version, bad count, …). */
export class ValidationError extends WebsearchToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/**
 * No usable provider for this request: the named provider is not on the tool's
 * allowlist, or no provider was named and the tool has no default. This is a
 * deployment/allowlist condition, distinct from a provider rejecting the call.
 */
export class ProviderNotConfiguredError extends WebsearchToolError {
  readonly code = 'provider_not_configured';
  readonly httpStatus = 503;
  constructor(public provider: string | undefined) {
    super(
      provider
        ? `Search provider "${provider}" is not configured on this tool.`
        : 'No search provider was specified and this tool has no default.',
    );
  }
  protected extraFields() {
    return { provider: this.provider ?? null };
  }
}

/** The provider rejected the credential (HTTP 401/403). */
export class ProviderUnauthorizedError extends WebsearchToolError {
  readonly code = 'provider_unauthorized';
  readonly httpStatus = 502;
  constructor(public provider: string) {
    super(`Search provider "${provider}" rejected the credential.`);
  }
  protected extraFields() {
    return { provider: this.provider };
  }
}

/** The provider rejected the request itself (HTTP 4xx other than 401/403/429). */
export class ProviderRejectedError extends WebsearchToolError {
  readonly code = 'provider_rejected';
  readonly httpStatus = 502;
  constructor(
    public provider: string,
    public providerStatus: number,
  ) {
    super(`Search provider "${provider}" rejected the request (status ${providerStatus}).`);
  }
  protected extraFields() {
    return { provider: this.provider, providerStatus: this.providerStatus };
  }
}

/** The provider rate-limited the request (HTTP 429). */
export class ProviderRateLimitedError extends WebsearchToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor(
    public provider: string,
    public retryAfterSeconds?: number,
  ) {
    super(`Search provider "${provider}" rate-limited the request.`);
  }
  protected extraFields() {
    return { provider: this.provider, ...(this.retryAfterSeconds != null ? { retryAfterSeconds: this.retryAfterSeconds } : {}) };
  }
}

/** Could not reach the provider (connection refused/reset, TLS, DNS, 5xx). */
export class UpstreamUnreachableError extends WebsearchToolError {
  readonly code = 'upstream_unreachable';
  readonly httpStatus = 502;
  constructor(
    public provider: string,
    detail?: string,
  ) {
    super(detail ? `Search provider "${provider}" is unreachable: ${detail}` : `Search provider "${provider}" is unreachable.`);
  }
  protected extraFields() {
    return { provider: this.provider };
  }
}

/** The provider did not respond within the tool's search budget. */
export class UpstreamTimeoutError extends WebsearchToolError {
  readonly code = 'upstream_timeout';
  readonly httpStatus = 504;
  constructor(
    public provider: string,
    public timeoutSeconds: number,
  ) {
    super(`Search provider "${provider}" timed out after ${timeoutSeconds}s.`);
  }
  protected extraFields() {
    return { provider: this.provider, timeoutSeconds: this.timeoutSeconds };
  }
}

/**
 * Build a ValidationError from a zod failure — the ONE place the
 * first-issue/path-join convention lives; `field`/`reason` are part of the
 * stable public error contract. Zod issue messages describe expected shapes and
 * never echo received values, so no credential can leak through this path.
 */
export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}
