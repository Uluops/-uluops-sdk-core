/** Authenticated server context; independent of the client's requested org. */
export interface ResponseContext {
  version: 1;
  orgSlug: string;
  source: 'bound-key' | 'request' | 'personal-default';
}
export interface WithResponseContext<T> { data: T; context: ResponseContext | null }

/** Missing, partial or malformed metadata never invalidates successful data. */
export function parseResponseContext(headers: Headers): ResponseContext | null {
  const version = headers.get('x-uluops-context-version');
  const orgSlug = headers.get('x-uluops-org-slug');
  const source = headers.get('x-uluops-org-source');
  if (version !== '1' || !orgSlug || !/^[a-zA-Z0-9_-]{1,100}$/.test(orgSlug) ||
      (source !== 'bound-key' && source !== 'request' && source !== 'personal-default')) return null;
  return { version: 1, orgSlug, source };
}

/** Best effort for frozen/foreign errors; do not replace the original failure. */
export function attachResponseContext(error: unknown, context: ResponseContext | null): void {
  if (error instanceof Error) {
    try { Object.defineProperty(error, 'responseContext', { value: context, configurable: true, enumerable: true }); } catch { /* preserve original error */ }
  }
}
