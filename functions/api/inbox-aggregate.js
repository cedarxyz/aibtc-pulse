// Aggregated inbox stats with KV caching
// GET /api/inbox-aggregate — returns totals, sender list, and real timestamped events
// Caches in PULSE_KV for 3 minutes to keep data fresh for the pulse chart

const API_BASE = 'https://aibtc.com/api';
const CACHE_KEY = 'inbox_aggregate';
const CACHE_TTL = 180; // 3 minutes — short enough to catch new messages quickly
const FETCH_TIMEOUT = 8000;

async function fetchJSON(path, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(API_BASE + path, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error(`Timeout fetching ${path}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

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

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;
  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';

  // Check cache (skip if ?fresh=true)
  if (kv && !skipCache) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached) {
        return Response.json({ ...cached, cached: true }, {
          headers: {
            'Cache-Control': 'public, max-age=60',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    } catch (e) {
      // KV read failed, proceed to fresh fetch
    }
  }

  try {
    // Fetch leaderboard for agent names + addresses
    const lb = await fetchJSON('/leaderboard');
    const agents = lb.leaderboard || [];
    const nameMap = {};
    for (const a of agents) {
      if (a.btcAddress) nameMap[a.btcAddress] = a.displayName || 'Unknown';
    }

    const addrs = agents.map(a => a.btcAddress).filter(Boolean);
    const addrSet = new Set(addrs);

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
              content: m.content ? m.content.slice(0, 140) : null,
              sats: m.paymentSatoshis || 0,
              time: m.sentAt,
            });
          }
        }
        if (hasSent) senderAddrs.push(addr);
      }
    }

    // Compute totals from deduplicated messages
    let totalMessages = msgMap.size;
    let totalSats = 0;
    const bucketMsgCounts = {};
    for (const { msg } of msgMap.values()) {
      totalSats += msg.paymentSatoshis || 0;
      // Bucket messages into 15-min intervals for relay-health chart
      const ts = parseTimestamp(msg.sentAt);
      if (ts > 0) {
        const d = new Date(ts);
        const q = Math.floor(d.getUTCMinutes() / 15) * 15;
        const key = d.toISOString().slice(0, 11)
          + String(d.getUTCHours()).padStart(2, '0') + ':'
          + String(q).padStart(2, '0');
        bucketMsgCounts[key] = (bucketMsgCounts[key] || 0) + 1;
      }
    }

    // Store 15-min message counts in KV for relay-health endpoint
    // No TTL — always overwritten with fresh data when inbox-aggregate runs
    if (kv) {
      try {
        await kv.put('inbox_hourly', JSON.stringify(bucketMsgCounts));
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
    recentEvents.sort((a, b) => parseTimestamp(b.time) - parseTimestamp(a.time));
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

    // Cache in KV
    if (kv) {
      try {
        await kv.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL });
      } catch (e) {
        // KV write failed, continue without caching
      }
    }

    return Response.json({ ...result, cached: false }, {
      headers: {
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
