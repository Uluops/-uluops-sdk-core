/**
 * Minimal fetch client interface used internally by auth strategies.
 *
 * {@link HttpClient} creates an implementation of this interface (via
 * `createFetchClient()`) and passes it to {@link JwtSessionAuth} so the
 * auth strategy can call `/auth/login` without a circular dependency on
 * the full HTTP client.
 *
 * The double-wrapped return type `{ data: { data: T } }` mirrors the
 * standard API envelope: the outer `data` comes from `response.json()`,
 * the inner `data` is the API's `{ data: T }` wrapper.
 */
export interface FetchClient {
  /** POST a JSON body and return the parsed response envelope */
  post<T>(url: string, body: object): Promise<{ data: { data: T } }>;
}
