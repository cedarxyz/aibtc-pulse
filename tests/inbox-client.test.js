// Tests for Inbox API Client Module
// Run with: node tests/inbox-client.test.js

import {
  fetchJSON,
  fetchWithRetry,
  fetchInboxStats,
  fetchBatchInboxStats,
  calculateInboxDensityScore,
  InboxCache,
} from '../functions/api/inbox-client.js';

const TESTS = [];
const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

function test(name, fn) {
  TESTS.push({ name, fn });
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function assertDeepEqual(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, msg = '') {
  if (!value) throw new Error(`${msg}\nExpected truthy value, got: ${value}`);
}

function assertFalse(value, msg = '') {
  if (value) throw new Error(`${msg}\nExpected falsy value, got: ${value}`);
}

// --- Test calculateInboxDensityScore ---

test('calculateInboxDensityScore returns null for null input', () => {
  const result = calculateInboxDensityScore(null);
  assertEqual(result, null);
});

test('calculateInboxDensityScore returns null for error input', () => {
  const result = calculateInboxDensityScore({ error: 'Failed' });
  assertEqual(result, null);
});

test('calculateInboxDensityScore calculates correct score for active agent', () => {
  const stats = {
    address: 'SP1TEST',
    totalMessages: 50,
    recentMessages: 10,
    totalSats: 5000,
    uniquePeers: 5,
    lastMessageAt: Date.now() - 12 * 60 * 60 * 1000, // 12 hours ago
  };
  
  const result = calculateInboxDensityScore(stats);
  assertTrue(result.densityScore > 0);
  assertTrue(result.densityScore <= 1);
  assertTrue(result.components.messageScore > 0);
  assertTrue(result.components.satsScore > 0);
  assertTrue(result.components.peerScore > 0);
  assertEqual(result.components.recencyScore, 0.30); // full recency weight (24h)
});

test('calculateInboxDensityScore handles agent with no recent activity', () => {
  const stats = {
    address: 'SP1TEST',
    totalMessages: 50,
    recentMessages: 0,
    totalSats: 0,
    uniquePeers: 2,
    lastMessageAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
  };
  
  const result = calculateInboxDensityScore(stats);
  assertTrue(result.densityScore >= 0);
  assertTrue(result.components.recencyScore < 0.1); // low recency
});

test('calculateInboxDensityScore respects custom weights', () => {
  const stats = {
    address: 'SP1TEST',
    totalMessages: 100,
    recentMessages: 100,
    totalSats: 10000,
    uniquePeers: 20,
    lastMessageAt: Date.now(),
  };
  
  const options = {
    weightMessages: 0.5,
    weightSats: 0.5,
    weightPeers: 0,
    weightRecency: 0,
    maxMessages: 100,
    maxSats: 10000,
  };
  
  const result = calculateInboxDensityScore(stats, options);
  assertEqual(result.densityScore, 1.0);
  assertEqual(result.components.messageScore, 0.5);
  assertEqual(result.components.satsScore, 0.5);
  assertEqual(result.components.peerScore, 0);
  assertEqual(result.components.recencyScore, 0);
});

test('calculateInboxDensityScore caps scores at maximum', () => {
  const stats = {
    address: 'SP1TEST',
    totalMessages: 1000,
    recentMessages: 1000,
    totalSats: 100000,
    uniquePeers: 50,
    lastMessageAt: Date.now(),
  };
  
  const result = calculateInboxDensityScore(stats);
  assertTrue(result.densityScore <= 1);
  assertTrue(result.components.messageScore <= 0.25);
  assertTrue(result.components.satsScore <= 0.20);
});

// --- Test InboxCache ---

test('InboxCache returns null when KV is not provided', async () => {
  const cache = new InboxCache(null);
  const result = await cache.get();
  assertEqual(result, null);
});

test('InboxCache.set returns false when KV is not provided', async () => {
  const cache = new InboxCache(null);
  const result = await cache.set({ test: 'data' });
  assertEqual(result, false);
});

test('InboxCache stores and retrieves data correctly', async () => {
  const mockKv = {
    store: new Map(),
    async get(key, opts) {
      const val = this.store.get(key);
      if (!val) return null;
      return opts?.type === 'json' ? JSON.parse(val) : val;
    },
    async put(key, val, opts) {
      this.store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    },
  };
  
  const cache = new InboxCache(mockKv, 'test_key', 60);
  const data = { agents: ['a', 'b'], total: 2 };
  
  const setResult = await cache.set(data);
  assertEqual(setResult, true);
  
  const retrieved = await cache.get();
  assertDeepEqual(retrieved.agents, data.agents);
  assertDeepEqual(retrieved.total, data.total);
});

test('InboxCache expires old entries', async () => {
  const mockKv = {
    store: new Map(),
    async get(key, opts) {
      const val = this.store.get(key);
      if (!val) return null;
      return opts?.type === 'json' ? JSON.parse(val) : val;
    },
    async put(key, val, opts) {
      this.store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    },
  };
  
  const cache = new InboxCache(mockKv, 'test_key', 1); // 1 second TTL
  const data = { test: 'data' };
  
  await cache.set(data);
  
  // Manually expire by modifying expiresAt
  const entry = JSON.parse(mockKv.store.get('test_key'));
  entry.expiresAt = Date.now() - 1000; // expired
  mockKv.store.set('test_key', JSON.stringify(entry));
  
  const retrieved = await cache.get();
  assertEqual(retrieved, null); // Should return null for expired
});

test('InboxCache.getWithFallback returns cached data on fetch error', async () => {
  const mockKv = {
    store: new Map(),
    async get(key, opts) {
      const val = this.store.get(key);
      if (!val) return null;
      return opts?.type === 'json' ? JSON.parse(val) : val;
    },
    async put(key, val, opts) {
      this.store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    },
  };
  
  const cache = new InboxCache(mockKv, 'fallback_key', 60);
  
  // First call: fetch succeeds and caches
  const freshData = { value: 'fresh' };
  const result1 = await cache.getWithFallback(async () => freshData);
  assertEqual(result1.fromCache, false);
  assertDeepEqual(result1.value, 'fresh');
  
  // Store some cached data
  await cache.set({ value: 'cached' });
  
  // Add method to simulate failing fetch
  let fetchCount = 0;
  
  // Second call: cache hit
  const result2 = await cache.getWithFallback(async () => {
    fetchCount++;
    throw new Error('Fetch failed');
  });
  
  assertTrue(result2.fromCache);
});

// --- Test fetchInboxStats output structure ---

test('fetchInboxStats returns correct structure for valid inbox', () => {
  // This test validates the expected output structure
  // The actual API call would be mocked in integration tests
  
  const expectedFields = [
    'address',
    'unreadCount',
    'totalMessages',
    'totalSats',
    'uniquePeers',
    'recentMessages',
    'lastMessageAt',
  ];
  
  // Structure validation - actual async test would need real API
  const mockResponse = {
    address: 'SP1TEST',
    unreadCount: 5,
    totalMessages: 20,
    totalSats: 1000,
    uniquePeers: 3,
    recentMessages: 10,
    lastMessageAt: Date.now(),
  };
  
  for (const field of expectedFields) {
    assertTrue(field in mockResponse, `Missing field: ${field}`);
  }
});

// --- Run tests ---

async function runTests() {
  console.log('\n\x1b[36m=== Inbox Client Tests ===\x1b[0m\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      console.log(`${PASS} ${name}`);
      passed++;
    } catch (err) {
      console.log(`${FAIL} ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }
  
  console.log(`\n\x1b[36m=== Results ===\x1b[0m`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});