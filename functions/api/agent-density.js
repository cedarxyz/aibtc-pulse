// Agent Density — agents who sent x402 paid messages to other agents in the last 30 days
// GET /api/agent-density — returns count + list of agents who sent paid messages
// Sources data from inbox-aggregate's inbox scraping, caches in PULSE_KV
// Uses stale-while-revalidate: returns stale data instantly, refreshes in background

const API_BASE = 'https://aibtc.com/api';
const CACHE_KEY = 'agent_density';
const FRESH_MS = 15 * 60 * 1000;  // 15 minutes — consider stale after this
const KV_TTL = 3600;              // 1 hour — keep in KV for stale serving
const LOCK_KEY = 'agent_density_refreshing';
const LOCK_TTL = 60;              // 1 minute lock to prevent stampede

const HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
};

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return res.json();
}

// Paginate through all inbox messages for an agent
async function fetchAllInbox(addr) {
  const allMsgs = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < 10; page++) {
    const data = await fetchJSON(`${API_BASE}/inbox/${addr}?limit=${limit}&offset=${offset}`);
    const msgs = data?.inbox?.messages || [];
    allMsgs.push(...msgs);
    if (!data?.inbox?.hasMore || msgs.length === 0) break;
    offset = data?.inbox?.nextOffset ?? (offset + limit);
  }
  return allMsgs;
}

// Background-safe refresh: computes fresh density and writes to KV
async function refreshDensity(kv) {
  // Acquire lock
  if (kv) {
    try { await kv.put(LOCK_KEY, '1', { expirationTtl: LOCK_TTL }); } catch (e) { /* continue */ }
  }
  try {
    // Fetch all agents (paginated — leaderboard caps at 100 per page)
    const agents = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const data = await fetchJSON(API_BASE + `/leaderboard?limit=${limit}&offset=${offset}`);
      if (!data?.leaderboard) break;
      const page = data.leaderboard;
      agents.push(...page);
      if (!data.pagination?.hasMore || page.length === 0) break;
      offset += limit;
    }
    if (agents.length === 0) throw new Error('Failed to fetch leaderboard');
    const now = Date.now();
    const THIRTY_DAYS = 30 * 86400000;
    const cutoff = now - THIRTY_DAYS;

    const nameMap = {};
    for (const a of agents) {
      if (a.btcAddress) nameMap[a.btcAddress] = a.displayName || 'Unknown';
    }

    const allAddrs = agents.map(a => a.btcAddress).filter(Boolean);

    // All registered agents count as valid recipients
    const agentAddrSet = new Set(allAddrs);

    // Only scan inboxes of agents active in the last 30 days (skip inactive/dormant ones)
    const addrs = agents
      .filter(a => a.btcAddress && a.lastActiveAt && (now - new Date(a.lastActiveAt).getTime()) < THIRTY_DAYS)
      .map(a => a.btcAddress);

    // Fetch inboxes and find agents who SENT paid x402 messages in last 30 days
    const activeMessagers = new Map();
    const BATCH_SIZE = 10;

    for (let i = 0; i < addrs.length; i += BATCH_SIZE) {
      const batch = addrs.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(addr => fetchAllInbox(addr).then(msgs => ({ addr, msgs })))
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { addr, msgs } = r.value;

        let msgCount = 0;
        let lastMsgAt = null;

        for (const m of msgs) {
          if (!m.sentAt || !(m.paymentSatoshis > 0)) continue;
          if (m.direction !== 'sent') continue;
          const peerAddr = m.peerBtcAddress || m.fromAddress;
          if (!peerAddr || !agentAddrSet.has(peerAddr)) continue;
          const msgTime = new Date(m.sentAt).getTime();
          if (msgTime < cutoff) continue;

          msgCount++;
          if (!lastMsgAt || msgTime > lastMsgAt) lastMsgAt = msgTime;
        }

        if (msgCount > 0) {
          activeMessagers.set(addr, {
            displayName: nameMap[addr] || 'Unknown',
            btcAddress: addr,
            messageCount: msgCount,
            lastMessageAt: new Date(lastMsgAt).toISOString(),
          });
        }
      }
    }

    const agentList = Array.from(activeMessagers.values())
      .sort((a, b) => b.messageCount - a.messageCount);

    const totalActive = agents.filter(a =>
      a.lastActiveAt && (now - new Date(a.lastActiveAt).getTime()) < THIRTY_DAYS
    ).length;

    const result = {
      density: agentList.length,
      totalActive,
      totalAgents: agents.length,
      totalMessages30d: agentList.reduce((sum, a) => sum + a.messageCount, 0),
      agents: agentList,
      generatedAt: new Date().toISOString(),
    };

    // Write today's density into daily_snapshots so history.js includes it in timeline
    if (kv) {
      try {
        const pacificFmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const today = pacificFmt.format(new Date());
        const raw = await kv.get('daily_snapshots', { type: 'json' });
        if (raw && raw[today]) {
          raw[today].density = agentList.length;
          await kv.put('daily_snapshots', JSON.stringify(raw));
          await kv.delete('timeline_cache');
        }
      } catch (e) { /* non-critical */ }
    }

    // Cache in KV with long TTL for stale serving
    if (kv) {
      try {
        await kv.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: KV_TTL });
      } catch (e) { /* continue */ }
    }

    return result;
  } finally {
    // Release lock
    if (kv) {
      try { await kv.delete(LOCK_KEY); } catch (e) { /* ignore */ }
    }
  }
}

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;
  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';

  // Check cache
  if (kv && !skipCache) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached) {
        const age = Date.now() - new Date(cached.generatedAt).getTime();
        if (age < FRESH_MS) {
          // Fresh — return immediately
          return Response.json({ ...cached, cached: true }, { headers: HEADERS });
        }
        // Stale — return immediately, refresh in background (with lock to prevent stampede)
        const isRefreshing = await kv.get(LOCK_KEY);
        if (!isRefreshing) {
          context.waitUntil(refreshDensity(kv).catch(() => {}));
        }
        return Response.json({ ...cached, cached: true, stale: true }, { headers: HEADERS });
      }
    } catch (e) {
      // KV read failed, proceed
    }
  }

  // No cache at all — must compute synchronously
  try {
    const result = await refreshDensity(kv);
    return Response.json(result, { headers: HEADERS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
