/**
 * Structured security-event channel for UluOps SDKs.
 *
 * sdk-core performs no runtime security telemetry of its own (see SCOPE.md) — it
 * is a client library with no server, store, or background loop. What it CAN do
 * is hand the embedding application a single, routable, structured channel for
 * the security-relevant events it already observes, instead of forcing the
 * embedder to scrape free-text `console.warn` output or classify thrown errors.
 *
 * A consumer wires one `onSecurityEvent` handler and forwards these to whatever
 * telemetry sink it owns (SIEM, Sentry, structured logs). The SDK never decides
 * what is "an incident" — it reports facts; the embedder sets policy.
 *
 * ## Why one hook, not many
 *
 * The pre-0.14.0 callbacks (`onRetry`, `onRateLimitApproaching`, `onTokenRefresh`)
 * are operational signals, each with a distinct payload shape and call site. The
 * security events here share a common envelope and a single routing decision
 * ("is this worth alerting on?"), so they collapse into one discriminated-union
 * channel. New event kinds are added to the union without widening the config
 * surface.
 *
 * ## Credential safety
 *
 * Every field on every event is constructed by the SDK from non-secret inputs or
 * from values already sanitized at their trust boundary. Handlers may log events
 * verbatim. `message` is a human-readable summary; the structured fields are for
 * routing and correlation.
 *
 * ## Delivery contract
 *
 * Events are best-effort and fire-and-forget. A handler that throws is caught and
 * logged — it never propagates into request flow. Handlers should be fast and
 * non-blocking; the SDK does not await them.
 */

/** Discriminator for {@link SecurityEvent}. */
export type SecurityEventType =
  | 'auth_failure'
  | 'redirect_rejected'
  | 'token_refresh_failed'
  | 'auth_strategy_replaced';

/** Credential kind an event pertains to. `none` = no auth strategy configured. */
export type AuthType = 'api_key' | 'session' | 'none';

/** Fields common to every security event. */
export interface SecurityEventBase {
  /** Event kind discriminator. */
  type: SecurityEventType;
  /** ISO 8601 timestamp of when the SDK observed the event. */
  timestamp: string;
  /** Credential-safe, human-readable summary suitable for logging verbatim. */
  message: string;
}

/**
 * The server rejected sent credentials with a 401. Distinguishes an active
 * rejection (a credential was presented and refused — possibly expired, revoked,
 * or a substituted key that the server does not accept) from the no-credentials
 * case. This is the SDK-observable signal for the "credential substitution"
 * threat: a swapped-but-invalid credential surfaces here; a swapped-but-valid one
 * is, by definition, indistinguishable from legitimate use at the client.
 */
export interface AuthFailureEvent extends SecurityEventBase {
  type: 'auth_failure';
  /** Credential kind that was rejected. */
  authType: AuthType;
  /** HTTP status that triggered the event (401). */
  statusCode: number;
  /** Server correlation id (`x-request-id`), control-char stripped, if present. */
  requestId?: string;
}

/**
 * The configured origin returned a 3xx redirect, which the SDK refused to follow.
 * A redirect from an origin the consumer configured is a configuration or
 * man-in-the-middle signal. Pairs with {@link RedirectError} thrown to the caller.
 */
export interface RedirectRejectedEvent extends SecurityEventBase {
  type: 'redirect_rejected';
  /** The configured origin that issued the redirect. */
  baseUrl: string;
}

/**
 * A token refresh (re-login) attempt failed. A refresh failure means a
 * previously-working session credential was rejected at re-authentication —
 * expired, revoked, or otherwise no longer valid. Fires at most once per request
 * (refresh is attempted once).
 */
export interface TokenRefreshFailedEvent extends SecurityEventBase {
  type: 'token_refresh_failed';
  /** Always `session` — only session strategies refresh. */
  authType: 'session';
}

/**
 * The live auth strategy was replaced via `setAuthStrategy`. This is an
 * intended, trusted-caller capability (login swaps in a session token), but it
 * changes which credential the client exercises, so it is surfaced for
 * observability. A holder of the client reference replacing the credential
 * unexpectedly is a confused-deputy signal worth correlating.
 */
export interface AuthStrategyReplacedEvent extends SecurityEventBase {
  type: 'auth_strategy_replaced';
  /** Credential kind before replacement. */
  previousType: AuthType;
  /** Credential kind after replacement. */
  newType: AuthType;
}

/**
 * Discriminated union of all security events delivered to `onSecurityEvent`.
 * Switch on `event.type` to narrow.
 */
export type SecurityEvent =
  | AuthFailureEvent
  | RedirectRejectedEvent
  | TokenRefreshFailedEvent
  | AuthStrategyReplacedEvent;

/** Handler signature for the `onSecurityEvent` config option. */
export type SecurityEventHandler = (event: SecurityEvent) => void;
