/**
 * Test setup for @uluops/sdk-core
 */
import nock from 'nock';
import { beforeEach, afterEach, afterAll } from 'vitest';

// Test constants
export const TEST_BASE_URL = 'http://localhost:3100';
export const TEST_BASE_PATH = '/api/v1';
export const TEST_FULL_URL = `${TEST_BASE_URL}${TEST_BASE_PATH}`;
export const TEST_API_KEY = 'ulr_test_key_1234567890abcdef';
export const TEST_UUID = '550e8400-e29b-41d4-a716-446655440000';
/** Structurally valid JWT for tests (jwt.io demo token — NOT a real credential) */
export const TEST_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlRlc3QiLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
/** Stale JWT for 401 refresh tests — structurally valid but represents an expired token */
export const TEST_JWT_STALE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFsZSJ9.stale_signature_placeholder';

// Nock setup
beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
  // Reset env vars
  delete process.env.ULUOPS_API_KEY;
  delete process.env.ULUOPS_EMAIL;
  delete process.env.ULUOPS_PASSWORD;
  delete process.env.ULUOPS_SESSION_TOKEN;
  delete process.env.ULUOPS_BASE_URL;
  delete process.env.ULUOPS_DEBUG;
});

afterAll(() => {
  nock.restore();
});
