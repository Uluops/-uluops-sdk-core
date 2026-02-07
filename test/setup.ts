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
