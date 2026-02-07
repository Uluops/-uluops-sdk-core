/**
 * Minimal fetch client interface used by auth strategies for login/refresh
 */
export interface FetchClient {
  post<T>(url: string, body: object): Promise<{ data: { data: T } }>;
}
