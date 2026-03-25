// Inbox API Client Module for AIBTC Protocol
// Provides functions to fetch agent inbox stats with error handling and caching

const INBOX_API_BASE = 'https://aibtc.com/api';
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;

async function fetchJSON(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'aibtc-dashboard/1.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, status: res.status };
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    return { error: err.message || 'Request failed' };
  }
}

async function fetchWithRetry(url, retries = MAX_RETRIES, timeoutMs = FETCH_TIMEOUT_MS) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fetchJSON(url, timeoutMs);
    if (!result.error) return result;
  }
  return { error: 'Max retries exceeded' };
}

async function fetchInboxStats(stxAddress, timeoutMs = FETCH_TIMEOUT_MS, maxPages = 10) {
  const allMessages = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;
  
  for (let page = 0; page < maxPages && hasMore; page++) {
    const data = await fetchWithRetry(
      `${INBOX_API_BASE}/inbox/${stxAddress}?status=unread&limit=${limit}&offset=${offset}`,
      1,
      timeoutMs
    );
    
    if (data.error) return { error: data.error, address: stxAddress };
    
    const inbox = data.inbox || data;
    const messages = Array.isArray(inbox) ? inbox : (inbox.messages || []);
    
    allMessages.push(...messages);
    
    hasMore = data.inbox?.hasMore ?? (messages.length === limit);
    offset = data.inbox?.nextOffset ?? (offset + limit);
    
    if (messages.length === 0) break;
  }
  
  const messages = allMessages;
  const unreadCount = messages.filter(m => m.status === 'unread' || !m.readAt).length;
  const totalMessages = messages.length;
  const totalSats = messages.reduce((sum, m) => sum + (m.paymentSatoshis || 0), 0);
  const uniquePeers = new Set(messages.map(m => m.peerBtcAddress || m.fromAddress).filter(Boolean)).size;
  
  const last7Days = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentMessages = messages.filter(m => {
    const sentAt = m.sentAt ? new Date(m.sentAt).getTime() : 0;
    return sentAt >= last7Days;
  });
  
  const lastMessageAt = messages.length > 0 
    ? messages.reduce((latest, m) => {
        const t = m.sentAt ? new Date(m.sentAt).getTime() : 0;
        return t > latest ? t : latest;
      }, 0)
    : null;
  
  return {
    address: stxAddress,
    unreadCount,
    totalMessages,
    totalSats,
    uniquePeers,
    recentMessages: recentMessages.length,
    lastMessageAt,
  };
}

async function fetchBatchInboxStats(addresses, batchSize = 6) {
  const results = [];
  
  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(addr => fetchInboxStats(addr))
    );
    
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ error: r.reason?.message || 'Failed', address: 'unknown' });
      }
    }
  }
  
  return results;
}

function calculateInboxDensityScore(inboxStats, options = {}) {
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
}

class InboxCache {
  constructor(kv, key = 'inbox_stats_cache', ttlSeconds = 180) {
    this.kv = kv || null;
    this.key = key;
    this.ttl = ttlSeconds;
  }
  
  async get() {
    if (!this.kv) return null;
    try {
      const cached = await this.kv.get(this.key, { type: 'json' });
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    } catch (e) {
    }
    return null;
  }
  
  async set(data) {
    if (!this.kv) return false;
    try {
      const cacheEntry = {
        data,
        expiresAt: Date.now() + (this.ttl * 1000),
        generatedAt: new Date().toISOString(),
      };
      await this.kv.put(this.key, JSON.stringify(cacheEntry), { expirationTtl: this.ttl });
      return true;
    } catch (e) {
    }
    return false;
  }
  
  async getWithFallback(fetchFn) {
    const cached = await this.get();
    if (cached) return { ...cached, fromCache: true };
    
    try {
      const fresh = await fetchFn();
      await this.set(fresh);
      return { ...fresh, fromCache: false };
    } catch (err) {
      if (cached) {
        return { ...cached, fromCache: true, stale: true, error: err.message };
      }
      throw err;
    }
  }
}

export {
  fetchJSON,
  fetchWithRetry,
  fetchInboxStats,
  fetchBatchInboxStats,
  calculateInboxDensityScore,
  InboxCache,
  INBOX_API_BASE,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
};