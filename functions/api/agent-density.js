// Agent Density — liveness + usefulness composite score
// GET /api/agent-density — returns count + list of active agents with density scores
// Uses stxAddress for inbox API calls (AIBTC protocol requirement)
// Caches in PULSE_KV for 15 minutes

import {
  fetchBatchInboxStats,
  calculateInboxDensityScore,
  InboxCache,
} from './inbox-client.js';

const API_BASE = 'https://aibtc.com/api';
const MEMPOOL_BASE = 'https://mempool.space/api';
const CACHE_KEY = 'agent_density';
const INBOX_CACHE_KEY = 'inbox_density_cache';
const CACHE_TTL = 900;

const STX_ADDRESS_REGEX = /^SP[0-9A-Z]{38,}$/;

const HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
};

function parseTimestamp(ts) {
  if (!ts) return 0;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  } catch {
    return 0;
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function getBtcBalance(btcAddress) {
  try {
    const data = await fetchJSON(`${MEMPOOL_BASE}/address/${btcAddress}`);
    if (!data?.chain_stats) return 0;
    const funded = data.chain_stats.funded_txo_sum || 0;
    const spent = data.chain_stats.spent_txo_sum || 0;
    return Math.max(0, funded - spent);
  } catch {
    return 0;
  }
}

function calculateRecencyScore(agent) {
  const lastActive = parseTimestamp(agent.lastActiveAt);
  if (lastActive === 0) return 0;
  
  const hoursSinceActive = (Date.now() - lastActive) / (60 * 60 * 1000);
  
  if (hoursSinceActive < 24) return 1.0;
  if (hoursSinceActive < 72) return 0.7;
  if (hoursSinceActive < 168) return 0.4;
  
  return 0.1;
}

function calculateCapabilityScore(agent) {
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
}

function calculateCombinedDensityScore(agent, btcBalance, inboxDensity, options = {}) {
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
}

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;
  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';
  const includeInbox = url.searchParams.get('inbox') !== 'false';

  const inboxCache = new InboxCache(kv, INBOX_CACHE_KEY, CACHE_TTL);

  if (kv && !skipCache) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached) {
        return Response.json({ ...cached, cached: true }, { headers: HEADERS });
      }
    } catch (e) {}
  }

  try {
    const lb = await fetchJSON(API_BASE + '/leaderboard');
    if (!lb?.leaderboard) {
      return Response.json({ error: 'Failed to fetch leaderboard' }, { status: 502 });
    }

    const agents = lb.leaderboard;
    const now = Date.now();
    const SEVEN_DAYS = 7 * 86400000;

    const activeAgents = agents.filter(a => {
      if (!a.btcAddress || !a.lastActiveAt) return false;
      const lastActive = parseTimestamp(a.lastActiveAt);
      return lastActive > 0 && (now - lastActive) < SEVEN_DAYS;
    });

    let inboxStatsMap = new Map();
    let inboxError = null;

    if (includeInbox && activeAgents.length > 0) {
      try {
        const stxAddresses = activeAgents
          .filter(a => a.stxAddress && STX_ADDRESS_REGEX.test(a.stxAddress))
          .map(a => a.stxAddress);
        
        if (stxAddresses.length > 0) {
          const inboxResults = await fetchBatchInboxStats(stxAddresses, 6);
          
          for (const result of inboxResults) {
            const matchingAgent = activeAgents.find(a => a.stxAddress === result.address);
            if (matchingAgent && !result.error) {
              const score = calculateInboxDensityScore(result);
              if (score) {
                inboxStatsMap.set(matchingAgent.btcAddress, score);
              }
            }
          }
        }
      } catch (err) {
        inboxError = err.message;
      }
    }

    const agentsWithDensity = [];
    const BATCH_SIZE = 6;

    for (let i = 0; i < activeAgents.length; i += BATCH_SIZE) {
      const batch = activeAgents.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (agent) => {
          const balance = await getBtcBalance(agent.btcAddress);
          const inboxDensity = inboxStatsMap.get(agent.btcAddress) || null;
          const score = calculateCombinedDensityScore(agent, balance, inboxDensity);
          return { agent, balance, inboxDensity, score };
        })
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { agent, balance, inboxDensity, score } = r.value;
        
        if (balance > 0 || (inboxDensity && inboxDensity.densityScore > 0)) {
          agentsWithDensity.push({
            displayName: agent.displayName,
            btcAddress: agent.btcAddress,
            stxAddress: agent.stxAddress,
            level: agent.level || 0,
            levelName: agent.levelName || 'Unverified',
            achievementCount: agent.achievementCount || 0,
            onChainIdentity: agent.caip19 ? true : false,
            balance,
            inboxMetrics: inboxDensity ? {
              totalMessages: inboxDensity.totalMessages,
              recentMessages: inboxDensity.recentMessages,
              totalSats: inboxDensity.totalSats,
              uniquePeers: inboxDensity.uniquePeers,
              densityScore: inboxDensity.densityScore,
            } : null,
            densityScore: score.combined,
            scoreComponents: score.breakdown,
            rawComponents: score.rawComponents,
            lastActiveAt: agent.lastActiveAt,
          });
        }
      }
    }

    agentsWithDensity.sort((a, b) => b.densityScore - a.densityScore);

    const totalInboxSats = Array.from(inboxStatsMap.values())
      .reduce((sum, s) => sum + (s.totalSats || 0), 0);
    const agentsWithInbox = Array.from(inboxStatsMap.values())
      .filter(s => s.densityScore > 0).length;

    const result = {
      density: agentsWithDensity.length,
      densityThreshold: 0.3,
      averageScore: agentsWithDensity.length > 0 
        ? agentsWithDensity.reduce((sum, a) => sum + a.densityScore, 0) / agentsWithDensity.length 
        : 0,
      scoreFormula: 'recency(40%) + messaging(25%) + onChain(20%) + capability(15%)',
      totalActive: activeAgents.length,
      totalAgents: agents.length,
      totalBtcSats: agentsWithDensity.reduce((sum, a) => sum + a.balance, 0),
      totalInboxSats,
      agentsWithInboxActivity: agentsWithInbox,
      inboxFetchError: inboxError,
      agents: agentsWithDensity.slice(0, 50),
      generatedAt: new Date().toISOString(),
    };

    if (kv) {
      try {
        const pacificFmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const today = pacificFmt.format(new Date());
        const raw = await kv.get('daily_snapshots', { type: 'json' });
        if (raw && raw[today]) {
          raw[today].density = agentsWithDensity.length;
          raw[today].inboxMetrics = {
            totalAgents: agentsWithInbox,
            totalSats: totalInboxSats,
          };
          await kv.put('daily_snapshots', JSON.stringify(raw));
          await kv.delete('timeline_cache');
        }
      } catch (e) {}

      try {
        await kv.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL });
      } catch (e) {}
    }

    return Response.json(result, { headers: HEADERS });
  } catch (err) {
    if (kv && !skipCache) {
      try {
        const fallback = await kv.get(CACHE_KEY, { type: 'json' });
        if (fallback) {
          return Response.json({
            ...fallback,
            cached: true,
            stale: true,
            error: err.message,
          }, { headers: HEADERS });
        }
      } catch {}
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
}