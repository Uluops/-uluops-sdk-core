export { HttpClient, type HttpClientConfig, type RequestStreamOptions, type RequestOptions } from './http-client.js';
export {
  ApiKeyAuth,
  JwtSessionAuth,
  createAuthStrategy,
  type AuthStrategy,
  type AuthConfig,
} from './auth-strategy.js';
export type { FetchClient } from './fetch-adapter.js';
export type {
  SecurityEvent,
  SecurityEventType,
  SecurityEventHandler,
  SecurityEventBase,
  AuthType,
  ConcreteAuthType,
  AuthFailureEvent,
  RedirectRejectedEvent,
  TokenRefreshFailedEvent,
  AuthStrategyReplacedEvent,
} from './security-events.js';

export { parseResponseContext, attachResponseContext, type ResponseContext, type WithResponseContext } from './response-context.js';
