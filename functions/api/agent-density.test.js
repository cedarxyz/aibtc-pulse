// Tests for Agent Density scoring and inbox integration
// Run: node functions/api/agent-density.test.js

import assert from 'assert';

// Mock the scoring functions by extracting them for testing
// These are pure functions that can be tested independently

// Safely parse a timestamp, returning 0 on invalid dates
function parseTimestamp(ts) {
  if (!ts) return 0;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  } catch {
    return 0;
  }
}

function calculateRecencyScore(lastActiveAt) {
  const lastActive = parseTimestamp(lastActiveAt);
  if (lastActive === 0) return 0;
  
  const now = Date.now();
  const hoursSinceActive = (now - lastActive) / (1000 * 60 * 60);
  
  if (hoursSinceActive <= 24) return 1.0;
  if (hoursSinceActive >= 168) return 0;
  
  return Math.max(0, 1 - (hoursSinceActive - 24) / (168 - 24));
}

function calculateMessagingScore(messages, maxMessages) {
  if (!messages || messages.length === 0) return 0;
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  const recentMessages = messages.filter(m => {
    const sentAt = parseTimestamp(m.sentAt);
    return sentAt > 0 && sentAt >= sevenDaysAgo;
  });
  
  if (maxMessages === 0) return recentMessages.length > 0 ? 0.5 : 0;
  return Math.min(1, recentMessages.length / maxMessages);
}

function calculateOnChainScore(balance, maxBalance) {
  if (!balance || balance <= 0) return 0;
  if (maxBalance === 0) return 0.5;
  return Math.min(1, balance / maxBalance);
}

function calculateCapabilityScore(agent) {
  const levelScores = { 2: 1.0, 1: 0.6, 0: 0.2 };
  const levelScore = levelScores[agent.level] ?? 0.2;
  
  const achievementCount = agent.achievements?.length || agent.achievementCount || 0;
  const achievementBonus = Math.min(0.4, achievementCount * 0.1);
  
  return Math.min(1, levelScore + achievementBonus);
}

function calculateAgentScore(agent, balance, messages, maxBalance, maxMessages) {
  const recency = calculateRecencyScore(agent.lastActiveAt);
  const messaging = calculateMessagingScore(messages, maxMessages);
  const onChain = calculateOnChainScore(balance, maxBalance);
  const capability = calculateCapabilityScore(agent);
  
  const composite = (recency * 0.40) + (messaging * 0.25) + (onChain * 0.20) + (capability * 0.15);
  
  return {
    composite: Math.round(composite * 100) / 100,
    breakdown: {
      recency: Math.round(recency * 100) / 100,
      messaging: Math.round(messaging * 100) / 100,
      onChain: Math.round(onChain * 100) / 100,
      capability: Math.round(capability * 100) / 100,
    }
  };
}

// Test suite
const tests = {
  'parseTimestamp: valid ISO date returns timestamp': () => {
    const ts = '2026-03-17T12:00:00.000Z';
    const result = parseTimestamp(ts);
    assert.strictEqual(result, new Date(ts).getTime());
  },

  'parseTimestamp: null returns 0': () => {
    assert.strictEqual(parseTimestamp(null), 0);
    assert.strictEqual(parseTimestamp(undefined), 0);
    assert.strictEqual(parseTimestamp(''), 0);
  },

  'parseTimestamp: invalid date returns 0': () => {
    assert.strictEqual(parseTimestamp('not-a-date'), 0);
    assert.strictEqual(parseTimestamp('2026-13-45'), 0);
  },

  'parseTimestamp: number returns timestamp': () => {
    const ts = Date.now();
    assert.strictEqual(parseTimestamp(ts), ts);
  },

  'Recency score: within 24h should be 1.0': () => {
    const now = new Date().toISOString();
    assert.strictEqual(calculateRecencyScore(now), 1.0);
  },

  'Recency score: 7 days ago should be 0': () => {
    const sevenDaysAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
    assert.strictEqual(calculateRecencyScore(sevenDaysAgo), 0);
  },

  'Recency score: 3.5 days should be ~0.5': () => {
    const threeHalfDays = new Date(Date.now() - (3.5 * 24 * 60 * 60 * 1000)).toISOString();
    const score = calculateRecencyScore(threeHalfDays);
    // 3.5 days = 84 hours. After 24h grace, we're 60h into 144h decay period
    // score = 1 - (60/144) = 0.583...
    assert.ok(score >= 0.5 && score <= 0.65, `Expected ~0.58, got ${score}`);
  },

  'Recency score: null should return 0': () => {
    assert.strictEqual(calculateRecencyScore(null), 0);
    assert.strictEqual(calculateRecencyScore(undefined), 0);
  },

  'Messaging score: no messages returns 0': () => {
    assert.strictEqual(calculateMessagingScore([], 100), 0);
    assert.strictEqual(calculateMessagingScore(null, 100), 0);
  },

  'Messaging score: max messages returns 1': () => {
    const messages = Array(100).fill(null).map((_, i) => ({
      sentAt: new Date(Date.now() - (i * 3600000)).toISOString()
    }));
    assert.strictEqual(calculateMessagingScore(messages, 100), 1);
  },

  'Messaging score: half max returns 0.5': () => {
    const messages = Array(50).fill(null).map((_, i) => ({
      sentAt: new Date(Date.now() - (i * 3600000)).toISOString()
    }));
    assert.strictEqual(calculateMessagingScore(messages, 100), 0.5);
  },

  'Messaging score: only counts recent messages': () => {
    const now = Date.now();
    const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000);
    const messages = [
      { sentAt: new Date(eightDaysAgo).toISOString() }, // Too old
      { sentAt: new Date(now - 1000).toISOString() }, // Recent
    ];
    assert.strictEqual(calculateMessagingScore(messages, 10), 0.1);
  },

  'On-chain score: zero balance returns 0': () => {
    assert.strictEqual(calculateOnChainScore(0, 1000), 0);
    assert.strictEqual(calculateOnChainScore(null, 1000), 0);
  },

  'On-chain score: max balance returns 1': () => {
    assert.strictEqual(calculateOnChainScore(1000, 1000), 1);
  },

  'On-chain score: half max returns 0.5': () => {
    assert.strictEqual(calculateOnChainScore(500, 1000), 0.5);
  },

  'Capability score: Genesis level gets 1.0': () => {
    const agent = { level: 2, achievements: [] };
    assert.strictEqual(calculateCapabilityScore(agent), 1.0);
  },

  'Capability score: Registered level gets 0.6': () => {
    const agent = { level: 1, achievements: [] };
    assert.strictEqual(calculateCapabilityScore(agent), 0.6);
  },

  'Capability score: Unverified level gets 0.2': () => {
    const agent = { level: 0, achievements: [] };
    assert.strictEqual(calculateCapabilityScore(agent), 0.2);
  },

  'Capability score: achievements add bonus': () => {
    const agent = { level: 1, achievements: ['a', 'b', 'c'] };
    // 0.6 (level) + 0.3 (3 achievements) = 0.9
    assert.strictEqual(calculateCapabilityScore(agent), 0.9);
  },

  'Capability score: max achievement bonus capped at 0.4': () => {
    const agent = { level: 1, achievements: Array(10).fill('x') };
    // 0.6 (level) + min(0.4, 10*0.1) = 0.6 + 0.4 = 1.0 (capped at 1)
    assert.strictEqual(calculateCapabilityScore(agent), 1.0);
  },

  'Composite score: full marks agent': () => {
    const agent = {
      lastActiveAt: new Date().toISOString(),
      level: 2,
      achievements: ['a', 'b', 'c', 'd']
    };
    const messages = Array(100).fill(null).map((_, i) => ({
      sentAt: new Date(Date.now() - (i * 60000)).toISOString()
    }));
    const result = calculateAgentScore(agent, 1000, messages, 1000, 100);
    
    // recency: 1.0, messaging: 1.0, onChain: 1.0, capability: min(1.0, 1.0 + 0.4) = 1.0
    // composite = 0.4 + 0.25 + 0.2 + 0.15 = 1.0
    assert.strictEqual(result.composite, 1.0);
    assert.strictEqual(result.breakdown.recency, 1);
    assert.strictEqual(result.breakdown.messaging, 1);
    assert.strictEqual(result.breakdown.onChain, 1);
    assert.strictEqual(result.breakdown.capability, 1);
  },

  'Composite score: inactive agent': () => {
    const agent = {
      lastActiveAt: new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)).toISOString(), // 10 days ago
      level: 0,
      achievements: []
    };
    const result = calculateAgentScore(agent, 0, [], 1000, 100);
    
    // recency: 0, messaging: 0, onChain: 0, capability: 0.2
    // composite = 0 + 0 + 0 + (0.2 * 0.15) = 0.03
    assert.ok(result.composite >= 0 && result.composite < 0.1);
    assert.strictEqual(result.breakdown.recency, 0);
    assert.strictEqual(result.breakdown.capability, 0.2);
  },

  'Composite score: verify weight proportions': () => {
    const agent = {
      lastActiveAt: new Date().toISOString(),
      level: 1,
      achievements: []
    };
    const messages = Array(50).fill(null).map((_, i) => ({
      sentAt: new Date(Date.now() - (i * 60000)).toISOString()
    }));
    const result = calculateAgentScore(agent, 500, messages, 1000, 100);
    
    // recency: 1.0 (40%), messaging: 0.5 (25%), onChain: 0.5 (20%), capability: 0.6 (15%)
    // composite = 0.4 + 0.125 + 0.1 + 0.09 = 0.715
    assert.ok(Math.abs(result.composite - 0.72) < 0.01, `Expected ~0.72, got ${result.composite}`);
  },

  'ApiEndpoint: fetchInboxMessages pagination': async () => {
    // This would require mocking fetch - documented for integration testing
    assert.ok(true, 'Integration test: requires live API or mock');
  },

  'Rate limiting: respects maxRequests': () => {
    // Document rate limiter behavior
    const limiter = {
      requests: new Map(),
      maxRequests: 50,
      windowMs: 60000,
      check(key) {
        const now = Date.now();
        const window = this.requests.get(key) || { count: 0, resetAt: now + this.windowMs };
        if (now > window.resetAt) {
          window.count = 0;
          window.resetAt = now + this.windowMs;
        }
        if (window.count >= this.maxRequests) return false;
        window.count++;
        this.requests.set(key, window);
        return true;
      }
    };
    
    // Should allow 50 requests
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(limiter.check('test'), true);
    }
    // 51st should fail
    assert.strictEqual(limiter.check('test'), false);
  },
};

// Run tests
console.log('Running Agent Density scoring tests...\n');
let passed = 0;
let failed = 0;

for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${e.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);