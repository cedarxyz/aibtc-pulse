// Aggregated inbox stats with KV caching + stale-while-revalidate
// GET /api/inbox-aggregate — returns totals, sender list, and real timestamped events
// Returns stale data instantly while refreshing in the background

const API_BASE = 'https://aibtc.com/api';
const CACHE_KEY = 'inbox_aggregate';
const FRESH_MS = 3 * 60 * 1000;  // 3 minutes — consider stale after this
const KV_TTL = 1800;              // 30 minutes — keep in KV for stale serving
const LOCK_KEY = 'inbox_aggregate_refreshing';
const LOCK_TTL = 60;              // 1 minute lock to prevent stampede

const HEADERS = {
  'Cache-Control': 'public, max-age=60',
  'Access-Control-Allow-Origin': '*',
};

async function fetchJSON(path) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
  });
  return res.json();
}

// Paginate through all inbox messages for an agent
async function fetchAllInbox(addr) {
  const allMsgs = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < 10; page++) {
    const data = await fetchJSON(`/inbox/${addr}?limit=${limit}&offset=${offset}`);
    const msgs = data?.inbox?.messages || [];
    allMsgs.push(...msgs);
    if (!data?.inbox?.hasMore || msgs.length === 0) break;
    offset = data?.inbox?.nextOffset ?? (offset + limit);
  }
  return allMsgs;
}

// Background-safe refresh: computes fresh data and writes to KV
async function refreshAggregate(kv) {
  // Acquire lock to prevent concurrent refreshes (stampede protection)
  if (kv) {
    try { await kv.put(LOCK_KEY, '1', { expirationTtl: LOCK_TTL }); } catch (e) { /* continue */ }
  }
  try {
    // Fetch all agents (paginated) + activity stats in parallel
    const [allAgents, activityRes] = await Promise.all([
      (async () => {
        const agents = [];
        let offset = 0;
        const limit = 50;
        while (true) {
          const data = await fetchJSON(`/agents?limit=${limit}&offset=${offset}`);
          const batch = data.agents || [];
          if (batch.length === 0) break;
          agents.push(...batch);
          if (!data.pagination?.hasMore) break;
          offset += limit;
        }
        return agents;
      })(),
      fetchJSON('/activity?limit=50'),
    ]);
    const agents = allAgents;
    const nameMap = {};
    for (const a of agents) {
      if (a.btcAddress) nameMap[a.btcAddress] = a.displayName || 'Unknown';
    }

    // Use server-side activity stats as authoritative totals
    // (inbox scraping misses messages from deregistered agents or failed fetches)
    const activityStats = activityRes.stats || {};
    const authoritativeMessages = activityStats.totalMessages || 0;
    const authoritativeSats = activityStats.totalSatsTransacted || 0;

    const addrs = agents.map(a => a.btcAddress).filter(Boolean);

    // Deduplicate messages by messageId across all agent inboxes
    const msgMap = new Map(); // messageId → { msg, ownerAddr }
    const senderAddrs = [];
    const recentEvents = [];

    // Fetch all inboxes in batches
    const batchSize = 6;
    for (let i = 0; i < addrs.length; i += batchSize) {
      const batch = addrs.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(addr =>
          fetchAllInbox(addr).then(msgs => ({ addr, msgs }))
        )
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { addr, msgs } = r.value;

        let hasSent = false;
        for (const m of msgs) {
          if (m.direction === 'sent') hasSent = true;

          // Deduplicate: only keep first occurrence of each messageId
          if (m.messageId && !msgMap.has(m.messageId)) {
            msgMap.set(m.messageId, { msg: m, ownerAddr: addr });
          }

          // Collect received messages for activity feed (skip sent to avoid duplicates)
          if (m.sentAt && m.direction === 'received') {
            recentEvents.push({
              type: 'message_received',
              agent: nameMap[addr] || 'Unknown',
              agentAddr: addr,
              peer: m.peerDisplayName || null,
              peerAddr: m.peerBtcAddress || null,
              content: m.content || null,
              sats: m.paymentSatoshis || 0,
              time: m.sentAt,
            });
          }
        }
        if (hasSent) senderAddrs.push(addr);
      }
    }

    // Use authoritative totals from activity API, fall back to inbox-scraped counts
    let totalMessages = authoritativeMessages || msgMap.size;
    let totalSats = authoritativeSats || 0;
    if (!authoritativeSats) {
      for (const { msg } of msgMap.values()) {
        totalSats += msg.paymentSatoshis || 0;
      }
    }

    // Bucket messages into 5-min intervals for relay-health chart (from inbox data)
    const bucketMsgCounts = {};
    for (const { msg } of msgMap.values()) {
      if (msg.sentAt) {
        const d = new Date(msg.sentAt);
        const m = Math.floor(d.getUTCMinutes() / 5) * 5;
        const key = d.toISOString().slice(0, 11)
          + String(d.getUTCHours()).padStart(2, '0') + ':'
          + String(m).padStart(2, '0');
        bucketMsgCounts[key] = (bucketMsgCounts[key] || 0) + 1;
      }
    }

    // Store 5-min message counts in KV for relay-health endpoint
    // Includes updatedAt so relay-health can detect stale data
    if (kv) {
      try {
        await kv.put('inbox_hourly', JSON.stringify({
          buckets: bucketMsgCounts,
          updatedAt: new Date().toISOString(),
        }));
      } catch (e) { /* continue */ }
    }

    // Add registration events from leaderboard
    for (const a of agents) {
      if (a.verifiedAt) {
        recentEvents.push({
          type: 'registered',
          agent: a.displayName || 'Unknown',
          agentAddr: a.btcAddress,
          level: a.levelName,
          time: a.verifiedAt,
        });
      }
    }

    // Sort by time descending, keep top 50
    recentEvents.sort((a, b) => new Date(b.time) - new Date(a.time));
    const topEvents = recentEvents.slice(0, 50);

    const result = {
      totalMessages,
      totalSats,
      senderCount: senderAddrs.length,
      senderAddrs,
      recentEvents: topEvents,
      agentCount: agents.length,
      generatedAt: new Date().toISOString(),
    };

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
          context.waitUntil(refreshAggregate(kv).catch(() => {}));
        }
        return Response.json({ ...cached, cached: true, stale: true }, { headers: HEADERS });
      }
    } catch (e) {
      // KV read failed, proceed to fresh compute
    }
  }

  // No cache at all — must compute synchronously (first-ever request or KV empty)
  try {
    const result = await refreshAggregate(kv);
    return Response.json({ ...result, cached: false }, { headers: HEADERS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
