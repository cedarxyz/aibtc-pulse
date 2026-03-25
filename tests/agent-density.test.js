// Tests for Agent Density Scoring with Inbox Integration
// Run with: node tests/agent-density.test.js

const calculateRecencyScore = (agent) => {
  if (!agent.lastActiveAt) return 0;
  
  const hoursSinceActive = (Date.now() - new Date(agent.lastActiveAt).getTime()) / (60 * 60 * 1000);
  
  if (hoursSinceActive < 24) return 1.0;
  if (hoursSinceActive < 72) return 0.7;
  if (hoursSinceActive < 168) return 0.4;
  
  return 0.1;
};

const calculateCapabilityScore = (agent) => {
  const level = agent.level || 0;
  const achievementCount = agent.achievementCount || 0;
  const hasOnChainIdentity = agent.onChainIdentity || agent.caip19 || false;
  
  let score = 0;
  
  if (level >= 2) score += 0.6;
  else if (level >= 1) score += 0.3;
  
  if (achievementCount > 0) {
    score += Math.min(achievementCount * 0.1, 0.3);
  }
  
  if (hasOnChainIdentity) {
    score += 0.1;
  }
  
  return Math.min(score, 1.0);
};

const calculateCombinedDensityScore = (agent, btcBalance, inboxDensity, options = {}) => {
  const {
    weightRecency = 0.40,
    weightMessaging = 0.25,
    weightOnChain = 0.20,
    weightCapability = 0.15,
    maxBtcSats = 50000,
  } = options;

  const recencyScore = calculateRecencyScore(agent);
  const messagingScore = inboxDensity?.densityScore || 0;
  const onChainScore = Math.min(btcBalance / maxBtcSats, 1);
  const capabilityScore = calculateCapabilityScore(agent);

  const combinedScore = (
    recencyScore * weightRecency +
    messagingScore * weightMessaging +
    onChainScore * weightOnChain +
    capabilityScore * weightCapability
  );

  return {
    combined: combinedScore,
    breakdown: {
      recency: recencyScore * weightRecency,
      messaging: messagingScore * weightMessaging,
      onChain: onChainScore * weightOnChain,
      capability: capabilityScore * weightCapability,
    },
    rawComponents: {
      recency: recencyScore,
      messaging: messagingScore,
      onChain: onChainScore,
      capability: capabilityScore,
    },
    btcBalance,
    inboxStats: inboxDensity,
  };
};

const calculateInboxDensityScore = (inboxStats, options = {}) => {
  if (!inboxStats || inboxStats.error) return null;
  
  const {
    weightMessages = 0.25,
    weightSats = 0.20,
    weightPeers = 0.25,
    weightRecency = 0.30,
    maxMessages = 100,
    maxSats = 10000,
    maxPeers = 20,
  } = options;
  
  const recentMessages = inboxStats.recentMessages || 0;
  const totalSats = inboxStats.totalSats || 0;
  const uniquePeers = inboxStats.uniquePeers || 0;
  
  let recencyScore = 0;
  if (inboxStats.lastMessageAt && inboxStats.lastMessageAt > 0) {
    const hoursSinceLastMessage = (Date.now() - inboxStats.lastMessageAt) / (60 * 60 * 1000);
    if (hoursSinceLastMessage < 24) recencyScore = 1.0;
    else if (hoursSinceLastMessage < 72) recencyScore = 0.7;
    else if (hoursSinceLastMessage < 168) recencyScore = 0.4;
    else recencyScore = 0.1;
  }
  
  const messageScore = Math.min(recentMessages / maxMessages, 1);
  const satsScore = Math.min(totalSats / maxSats, 1);
  const peerScore = Math.min(uniquePeers / maxPeers, 1);
  
  const densityScore = (
    messageScore * weightMessages +
    satsScore * weightSats +
    peerScore * weightPeers +
    recencyScore * weightRecency
  );
  
  return {
    ...inboxStats,
    densityScore,
    components: {
      messageScore: messageScore * weightMessages,
      satsScore: satsScore * weightSats,
      peerScore: peerScore * weightPeers,
      recencyScore: recencyScore * weightRecency,
    },
  };
};

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

function assertTrue(value, msg = '') {
  if (!value) throw new Error(`${msg}\nExpected truthy value, got: ${value}`);
}

function assertInRange(value, min, max, msg = '') {
  if (value < min || value > max) {
    throw new Error(`${msg}\nExpected ${value} to be in range [${min}, ${max}]`);
  }
}

// --- Combined Density Score Tests ---

test('calculateCombinedDensityScore returns 0 for agent with no activity or balance', () => {
  const agent = { lastActiveAt: null, level: 0 };
  const result = calculateCombinedDensityScore(agent, 0, null);
  assertEqual(result.combined, 0);
  assertEqual(result.breakdown.recency, 0);
  assertEqual(result.breakdown.messaging, 0);
  assertEqual(result.breakdown.onChain, 0);
});

test('calculateCombinedDensityScore weights BTC balance correctly (onChain component)', () => {
  const agent = { lastActiveAt: null, level: 0 };
  const result = calculateCombinedDensityScore(agent, 25000, null);
  
  // 25000 / 50000 = 0.5, * 0.20 weight = 0.10
  assertEqual(result.breakdown.onChain, 0.10);
  assertTrue(result.combined > 0);
});

test('calculateCombinedDensityScore caps BTC score at maximum', () => {
  const agent = { lastActiveAt: null, level: 0 };
  const result = calculateCombinedDensityScore(agent, 100000, null);
  
  // Should cap at 1.0 * 0.20 = 0.20
  assertEqual(result.breakdown.onChain, 0.20);
});

test('calculateCombinedDensityScore weights recent activity correctly (recency component)', () => {
  const agent = { lastActiveAt: new Date().toISOString(), level: 0 };
  const result = calculateCombinedDensityScore(agent, 0, null);
  
  // Recency within 24h = 1.0 * 0.40 =0.40
  assertEqual(result.breakdown.recency, 0.40);
});

test('calculateCombinedDensityScore degrades recency score over time', () => {
  const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  
  // Within 24 hours
  const result1 = calculateCombinedDensityScore({ lastActiveAt: hoursAgo(12), level: 0 }, 0, null);
  assertEqual(result1.rawComponents.recency, 1.0);
  assertInRange(result1.breakdown.recency, 0.39, 0.41);
  
  // Within 72 hours
  const result2 = calculateCombinedDensityScore({ lastActiveAt: hoursAgo(48), level: 0 }, 0, null);
  assertEqual(result2.rawComponents.recency, 0.7);
  assertInRange(result2.breakdown.recency, 0.27, 0.29); // 0.7 * 0.40
  
  // Within 7 days
  const result3 = calculateCombinedDensityScore({ lastActiveAt: hoursAgo(100), level: 0 }, 0, null);
  assertEqual(result3.rawComponents.recency, 0.4);
  assertInRange(result3.breakdown.recency, 0.15, 0.17); // 0.4 * 0.40
});

test('calculateCombinedDensityScore includes capability score for leveled agents', () => {
  const agent = { lastActiveAt: new Date().toISOString(), level: 2, achievementCount: 5 };
  const result = calculateCombinedDensityScore(agent, 0, null);
  
  // Genesis level = 0.6, 5 achievements = 0.3 (capped), total = 0.9 * 0.15 = 0.135
  assertTrue(result.breakdown.capability > 0);
  assertTrue(result.rawComponents.capability >= 0.6);
});

test('calculateCombinedDensityScore combines allfour components', () => {
  const agent = { 
    lastActiveAt: new Date().toISOString(), 
    level: 2,
    achievementCount: 3,
  };
  const inboxDensity = { densityScore: 0.8 };
  
  const result = calculateCombinedDensityScore(agent, 25000, inboxDensity);
  
  // Recency: 1.0 * 0.40 = 0.40
  // Messaging: 0.8 * 0.25 = 0.20
  // OnChain: 0.5 * 0.20 = 0.10
  // Capability: 0.9 * 0.15 = 0.135 (Genesis + 3 achievements)
  // Total ≈ 0.835
  
  assertTrue(result.combined > 0.7);
  assertTrue(result.combined < 1.0);
  assertInRange(result.breakdown.recency, 0.39, 0.41);
  assertInRange(result.breakdown.messaging, 0.19, 0.21);
  assertInRange(result.breakdown.onChain, 0.09, 0.11);
});

test('calculateCombinedDensityScore handles null inbox density', () => {
  const agent = { lastActiveAt: new Date().toISOString(), level: 1 };
  const result = calculateCombinedDensityScore(agent, 10000, null);
  
  assertTrue(result.combined > 0);
  assertEqual(result.breakdown.messaging, 0);
  assertTrue(result.breakdown.onChain > 0);
});

test('calculateCombinedDensityScore respects custom weights', () => {
  const agent = { lastActiveAt: new Date().toISOString(), level: 2, achievementCount: 10, caip19: 'test' };
  const inboxDensity = { densityScore: 1.0 };
  
  const options = {
    weightRecency: 0.25,
    weightMessaging: 0.25,
    weightOnChain: 0.25,
    weightCapability: 0.25,
    maxBtcSats: 50000,
  };
  
  const result = calculateCombinedDensityScore(agent, 50000, inboxDensity, options);
  
  // With custom weights: recency 0.25, messaging 0.25, onChain 0.25, capability 0.25
  // All components at max should give 1.0 (with floating point tolerance)
  // Recency: 1.0, Messaging: 1.0, OnChain: 1.0, Capability: 1.0 (Genesis + 10 achievements + identity)
  assertInRange(result.combined, 0.99, 1.01);
});

// --- Capability Score Tests ---

test('calculateCapabilityScore returns 0 for unverified agents', () => {
  const result = calculateCapabilityScore({ level: 0 });
  assertEqual(result, 0);
});

test('calculateCapabilityScore gives 0.3 base for Registered agents', () => {
  const result = calculateCapabilityScore({ level: 1 });
  assertInRange(result, 0.29, 0.31);
});

test('calculateCapabilityScore gives 0.6 base for Genesis agents', () => {
  const result = calculateCapabilityScore({ level: 2 });
  assertInRange(result, 0.59, 0.61);
});

test('calculateCapabilityScore adds 0.1 per achievement (capped at 0.3)', () => {
  const agent = { level: 1, achievementCount: 2 };
  const result = calculateCapabilityScore(agent);
  // 0.3 (Registered) + 0.2 (2 achievements) = 0.5
  assertInRange(result, 0.49, 0.51);
});

test('calculateCapabilityScore caps achievement bonus at 0.3', () => {
  const agent = { level: 1, achievementCount: 10 };
  const result = calculateCapabilityScore(agent);
  // 0.3 (Registered) + 0.3 (achievement cap) = 0.6
  assertInRange(result, 0.59, 0.61);
});

test('calculateCapabilityScore adds 0.1 for on-chain identity', () => {
  const agent = { level: 1, caip19: 'stacks:1/sip009:...' };
  const result = calculateCapabilityScore(agent);
  // 0.3 (Registered) + 0.1 (identity) = 0.4
  assertInRange(result, 0.39, 0.41);
});

test('calculateCapabilityScore caps at 1.0', () => {
  const agent = { level: 2, achievementCount: 10, caip19: 'stacks:1/sip009:...' };
  const result = calculateCapabilityScore(agent);
  // 0.6 (Genesis) + 0.3 (achievements) + 0.1 (identity) = 1.0
  assertInRange(result, 0.99, 1.01);
});

// --- Agent Ranking Tests ---

test('Agents with higher density scores rank higher', () => {
  const agentsData = [
    { name: 'Agent A', balance: 50000, inbox: { densityScore: 0.8 }, lastActive: new Date(), level: 2, achievements: 5 },
    { name: 'Agent B', balance: 25000, inbox: { densityScore: 0.5 }, lastActive: new Date(), level: 1, achievements: 2 },
    { name: 'Agent C', balance: 10000, inbox: { densityScore: 0.2 }, lastActive: new Date(), level: 0, achievements: 0 },
  ];
  
  const scored = agentsData.map(a => ({
    name: a.name,
    score: calculateCombinedDensityScore(
      { lastActiveAt: a.lastActive, level: a.level, achievementCount: a.achievements },
      a.balance,
      a.inbox
    ).combined,
  }));
  
  scored.sort((a, b) => b.score - a.score);
  
  assertEqual(scored[0].name, 'Agent A');
  assertEqual(scored[1].name, 'Agent B');
  assertEqual(scored[2].name, 'Agent C');
});

test('Agent with high inbox but no BTC can still rank well', () => {
  const agent1 = { name: 'No BTC', balance: 0, inbox: { densityScore: 0.9 }, lastActive: new Date(), level: 2, achievements: 3 };
  const agent2 = { name: 'Some BTC', balance: 5000, inbox: { densityScore: 0 }, lastActive: new Date(), level: 0, achievements: 0 };
  
  const score1 = calculateCombinedDensityScore(
    { lastActiveAt: agent1.lastActive, level: agent1.level, achievementCount: agent1.achievements },
    agent1.balance,
    agent1.inbox
  ).combined;
  
  const score2 = calculateCombinedDensityScore(
    { lastActiveAt: agent2.lastActive, level: agent2.level, achievementCount: agent2.achievements },
    agent2.balance,
    agent2.inbox
  ).combined;
  
  assertTrue(score1 > score2, 'High inbox + capability agent should outrank low BTC/low capability agent');
});

// --- Integration Scenario Tests ---

test('Real-world scenario: Active agent with moderate activity', () => {
  const agent = {
    lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    level: 2, // Genesis
    achievementCount: 4,
  };
  
  const inboxStats = {
    totalMessages: 45,
    recentMessages: 12,
    totalSats: 2500,
    uniquePeers: 8,
    lastMessageAt: Date.now() - 30 * 60 * 1000, // 30 min ago
  };
  
  const inboxDensity = calculateInboxDensityScore(inboxStats);
  const result = calculateCombinedDensityScore(agent, 10000, inboxDensity);
  
  assertTrue(result.combined > 0.4, 'Should have reasonable combined score');
  assertTrue(result.combined < 1.0, 'Should not exceed maximum score');
});

test('Edge case: All zeros should return 0 score', () => {
  const agent = { lastActiveAt: null, level: 0, achievementCount: 0 };
  const result = calculateCombinedDensityScore(agent, 0, { densityScore: 0 });
  assertEqual(result.combined, 0);
});

test('Edge case: Maximum values should score high', () => {
  const agent = { 
    lastActiveAt: new Date().toISOString(), 
    level: 2, 
    achievementCount: 10,
    caip19: 'stacks:1/sip009:...',
  };
  const inboxDensity = { densityScore: 1.0 };
  
  const result = calculateCombinedDensityScore(agent, 50000, inboxDensity);
  
  // With all components at max: should be close to 1.0
  // Recency: 1.0 * 0.40 = 0.40
  // Messaging: 1.0 * 0.25 = 0.25
  // OnChain: 1.0 * 0.20 = 0.20
  // Capability: 1.0 * 0.15 = 0.15
  // Total = 1.0
  assertInRange(result.combined, 0.99, 1.01);
});

// --- Run tests ---

async function runTests() {
  console.log('\n\x1b[36m=== Agent Density Scoring Tests ===\x1b[0m\n');
  
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