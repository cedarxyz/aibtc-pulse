const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const API_HOST = 'aibtc.com';

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Fetch JSON from aibtc.com ──
function fetchJSON(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      path: apiPath,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON from ' + apiPath)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── Cache for /history (rebuild every 2 min) ──
let historyCache = null;
let historyCacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000;

async function buildHistory() {
  const now = Date.now();
  if (historyCache && (now - historyCacheTime) < CACHE_TTL) return historyCache;

  console.log('[history] Rebuilding timeline...');

  // 1. Get leaderboard for agent registration dates + check-in counts
  const lb = await fetchJSON('/api/leaderboard');
  const agents = lb.leaderboard || [];

  // 2. Get all agent inboxes for message timestamps + sats
  const allMessages = [];
  const batchSize = 6;
  const addrs = agents.map(a => a.btcAddress).filter(Boolean);

  for (let i = 0; i < addrs.length; i += batchSize) {
    const batch = addrs.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(addr => fetchJSON('/api/inbox/' + addr))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const msgs = r.value?.inbox?.messages || [];
        for (const m of msgs) {
          if (m.sentAt) {
            allMessages.push({
              t: new Date(m.sentAt).getTime(),
              sats: m.paymentSatoshis || 0,
            });
          }
        }
      }
    }
  }

  // 3. Build events timeline

  // -- Agent registrations (exact dates from verifiedAt)
  const agentEvents = agents
    .filter(a => a.verifiedAt)
    .map(a => ({ t: new Date(a.verifiedAt).getTime() }))
    .sort((a, b) => a.t - b.t);

  // -- Messages sorted by time
  allMessages.sort((a, b) => a.t - b.t);

  // -- Check-ins: distribute each agent's check-ins evenly from verifiedAt to now
  //    This is an approximation since the API doesn't have per-checkin timestamps
  const checkinEvents = [];
  for (const agent of agents) {
    const count = agent.checkInCount || 0;
    if (count === 0 || !agent.verifiedAt) continue;
    const start = new Date(agent.verifiedAt).getTime();
    const span = now - start;
    if (span <= 0) continue;
    // Create synthetic check-in timestamps distributed over time
    // Use fewer points for agents with many check-ins to keep data manageable
    const step = Math.max(1, Math.floor(count / 50));
    for (let i = 0; i < count; i += step) {
      checkinEvents.push({ t: start + (span * i / count), count: step });
    }
    // Handle remainder
    const remainder = count % step;
    if (remainder > 0) {
      checkinEvents.push({ t: now - 60000, count: remainder });
    }
  }
  checkinEvents.sort((a, b) => a.t - b.t);

  // 4. Build daily cumulative timelines
  //    Find the earliest event
  const allTimes = [
    ...agentEvents.map(e => e.t),
    ...allMessages.map(e => e.t),
    ...checkinEvents.map(e => e.t),
  ];
  if (allTimes.length === 0) {
    historyCache = { timeline: [] };
    historyCacheTime = now;
    return historyCache;
  }

  const DAY = 24 * 60 * 60 * 1000;
  // Normalize earliest to start of day (UTC midnight)
  const earliestRaw = Math.min(...allTimes);
  const earliest = new Date(earliestRaw);
  earliest.setUTCHours(0, 0, 0, 0);
  const startDay = earliest.getTime();

  // End at today's midnight (don't create future buckets)
  const todayMidnight = new Date(now);
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const endDay = todayMidnight.getTime();

  // Generate daily buckets from earliest to today
  const timeline = [];
  let cumAgents = 0, cumCheckins = 0, cumMessages = 0, cumSats = 0;
  let aiIdx = 0, ciIdx = 0, miIdx = 0;

  for (let day = startDay; day <= endDay; day += DAY) {
    const dayEnd = day + DAY;

    while (aiIdx < agentEvents.length && agentEvents[aiIdx].t < dayEnd) {
      cumAgents++;
      aiIdx++;
    }
    while (ciIdx < checkinEvents.length && checkinEvents[ciIdx].t < dayEnd) {
      cumCheckins += checkinEvents[ciIdx].count;
      ciIdx++;
    }
    while (miIdx < allMessages.length && allMessages[miIdx].t < dayEnd) {
      cumMessages++;
      cumSats += allMessages[miIdx].sats;
      miIdx++;
    }

    timeline.push({
      t: day,
      agents: cumAgents,
      checkins: cumCheckins,
      messages: cumMessages,
      sats: cumSats,
    });
  }

  historyCache = { timeline, generated: now };
  historyCacheTime = now;
  console.log(`[history] Built ${timeline.length} days, ${agents.length} agents, ${allMessages.length} messages`);
  return historyCache;
}

// ── Server ──
http.createServer(async (req, res) => {
  // Custom history endpoint
  if (req.url === '/api/history') {
    try {
      const data = await buildHistory();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[history] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Proxy /api/* requests to aibtc.com
  if (req.url.startsWith('/api/')) {
    const options = {
      hostname: API_HOST,
      path: req.url,
      method: req.method,
      headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
    };

    const proxy = https.request(options, (apiRes) => {
      res.writeHead(apiRes.statusCode, {
        'Content-Type': apiRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      apiRes.pipe(res);
    });

    proxy.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    proxy.end();
    return;
  }

  // Serve static files
  const publicDir = path.join(__dirname, 'public');
  const urlPath = req.url === '/' ? '/index.html' : req.url;

  // Reject any path containing '..' to prevent directory traversal
  if (urlPath.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = path.join(publicDir, urlPath);

  // Verify the resolved path is inside publicDir
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
