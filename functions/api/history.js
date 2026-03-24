// Daily cumulative timeline with KV snapshots
// GET /api/history — returns timeline of agents, check-ins, messages, sats per day
// Stores real daily snapshots in PULSE_KV (permanent), caches timeline for 5 minutes

const API_BASE = 'https://aibtc.com/api';
const CACHE_KEY = 'timeline_cache';
const CACHE_TTL = 300; // 5 minutes

async function fetchJSON(path) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'aibtc-dashboard/1.0' },
  });
  return res.json();
}

// ── DST-aware Pacific Time helpers ──
const pacificFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function pacificDateStr(ts) {
  return pacificFmt.format(new Date(ts)); // "2026-02-19"
}

function pacificMidnight(ts) {
  const dateStr = pacificDateStr(ts);
  // Pacific offset is -8 (PST) or -7 (PDT), so midnight Pacific = 07:00 or 08:00 UTC
  const pst = Date.parse(dateStr + 'T08:00:00Z'); // PST: midnight + 8h
  if (pacificDateStr(pst) === dateStr && pacificDateStr(pst - 1) !== dateStr) return pst;
  const pdt = Date.parse(dateStr + 'T07:00:00Z'); // PDT: midnight + 7h
  if (pacificDateStr(pdt) === dateStr && pacificDateStr(pdt - 1) !== dateStr) return pdt;
  return pst; // fallback
}

const HEADERS = {
  'Cache-Control': 'public, max-age=120',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequest(context) {
  const kv = context.env?.PULSE_KV;

  const url = new URL(context.request.url);
  const skipCache = url.searchParams.get('fresh') === 'true';

  // Check cache first (skip if ?fresh=true)
  if (kv && !skipCache) {
    try {
      const cached = await kv.get(CACHE_KEY, { type: 'json' });
      if (cached) {
        return Response.json({ ...cached, cached: true }, { headers: HEADERS });
      }
    } catch (e) {
      // KV read failed, proceed to fresh compute
    }
  }

  try {
    const now = Date.now();
    const today = pacificDateStr(now);

    // 1. Load existing daily snapshots from KV (permanent, no TTL)
    let snapshots = {};
    if (kv) {
      try {
        const raw = await kv.get('daily_snapshots', { type: 'json' });
        if (raw) snapshots = raw;
      } catch (e) { /* continue with empty */ }
    }

    // 2. Fetch leaderboard + health for current agent count + total check-ins
    const [lb, health] = await Promise.all([
      fetchJSON('/leaderboard'),
      fetchJSON('/health'),
    ]);
    const agents = lb.leaderboard || [];
    const verifiedAgents = agents.filter(a => a.verifiedAt);
    // Health endpoint has the true agent count (leaderboard may be paginated)
    const agentCount = health?.services?.kv?.agentCount || health?.services?.kv?.registeredCount || verifiedAgents.length;
    const totalCheckins = agents.reduce((sum, a) => sum + (a.checkInCount || 0), 0);

    // 3. Read inbox_aggregate from KV (avoid re-fetching all inboxes)
    let totalMessages = 0, totalSats = 0;
    if (kv) {
      try {
        const agg = await kv.get('inbox_aggregate', { type: 'json' });
        if (agg) {
          totalMessages = agg.totalMessages || 0;
          totalSats = agg.totalSats || 0;
        }
      } catch (e) { /* use zeros */ }
    }

    // 4. Write today's snapshot (real data, preserves density from agent-density endpoint)
    const existing = snapshots[today] || {};
    snapshots[today] = {
      agents: agentCount,
      checkins: totalCheckins,
      messages: totalMessages,
      sats: totalSats,
      ...(existing.density !== undefined ? { density: existing.density } : {}),
    };

    // 5. Seed historical dates from verifiedAt (agent registration backfill)
    //    Only creates placeholder entries for days we don't have snapshots yet
    for (const a of verifiedAgents) {
      const day = pacificDateStr(new Date(a.verifiedAt).getTime());
      if (!snapshots[day]) {
        snapshots[day] = { agents: 0, checkins: 0, messages: 0, sats: 0, seeded: true };
      }
    }

    // 6. Save snapshots to KV (permanent — no expirationTtl)
    if (kv) {
      try {
        await kv.put('daily_snapshots', JSON.stringify(snapshots));
      } catch (e) { /* continue */ }
    }

    // 7. Backfill check-in estimates for seeded days
    //    Distribute each agent's checkInCount proportionally from verifiedAt to today
    const todayMs = pacificMidnight(now);
    const DAY_MS = 86400000;
    const agentCheckinEstimates = verifiedAgents
      .filter(a => a.checkInCount > 0)
      .map(a => {
        const regDay = pacificDateStr(new Date(a.verifiedAt).getTime());
        const regMs = pacificMidnight(Date.parse(regDay + 'T12:00:00Z'));
        const totalDays = Math.max(1, Math.round((todayMs - regMs) / DAY_MS));
        const dailyRate = a.checkInCount / totalDays;
        return { regDay, regMs, dailyRate, total: a.checkInCount };
      });

    // Find earliest and latest real snapshot for message/sats interpolation
    const dates = Object.keys(snapshots).sort();
    const firstRealDate = dates.find(d => !snapshots[d].seeded);
    const firstRealMessages = firstRealDate ? (snapshots[firstRealDate].messages || 0) : totalMessages;
    const firstRealSats = firstRealDate ? (snapshots[firstRealDate].sats || 0) : totalSats;

    // 8. Build cumulative timeline from snapshots
    const timeline = [];
    let maxAgents = 0, maxCheckins = 0, maxMessages = 0, maxSats = 0;

    for (const date of dates) {
      const s = snapshots[date];
      const dayMs = pacificMidnight(Date.parse(date + 'T12:00:00Z'));

      // For seeded days, compute agent count from verifiedAt dates
      if (s.seeded) {
        s.agents = verifiedAgents.filter(a =>
          pacificDateStr(new Date(a.verifiedAt).getTime()) <= date
        ).length;

        // Estimate cumulative check-ins: sum each agent's proportional check-ins up to this date
        let estimatedCheckins = 0;
        for (const est of agentCheckinEstimates) {
          if (date >= est.regDay) {
            const daysActive = Math.max(1, Math.round((dayMs - est.regMs) / DAY_MS));
            estimatedCheckins += Math.min(Math.round(est.dailyRate * daysActive), est.total);
          }
        }
        s.checkins = estimatedCheckins;

        // Interpolate messages and sats linearly from 0 to first real snapshot value
        if (firstRealDate && date < firstRealDate) {
          const firstDateMs = pacificMidnight(Date.parse(firstRealDate + 'T12:00:00Z'));
          const startMs = pacificMidnight(Date.parse(dates[0] + 'T12:00:00Z'));
          const span = firstDateMs - startMs || 1;
          const progress = (dayMs - startMs) / span;
          s.messages = Math.round(firstRealMessages * progress);
          s.sats = Math.round(firstRealSats * progress);
        }
      }

      // Ensure monotonic (cumulative totals should never decrease)
      maxAgents = Math.max(maxAgents, s.agents || 0);
      maxCheckins = Math.max(maxCheckins, s.checkins || 0);
      maxMessages = Math.max(maxMessages, s.messages || 0);
      maxSats = Math.max(maxSats, s.sats || 0);

      const entry = {
        t: dayMs,
        agents: maxAgents,
        checkins: maxCheckins,
        messages: maxMessages,
        sats: maxSats,
        real: !s.seeded,
      };

      // Include density if snapshot has it (written by agent-density endpoint)
      if (s.density !== undefined) {
        entry.density = s.density;
      }

      timeline.push(entry);
    }

    // 9. Project today's partial data to a full-day estimate
    //    Calculate hours elapsed today in Pacific, extrapolate the delta from yesterday
    if (timeline.length >= 2) {
      const last = timeline[timeline.length - 1];
      const prev = timeline[timeline.length - 2];
      const midnightToday = pacificMidnight(now);
      const hoursElapsed = (now - midnightToday) / 3600000;

      if (hoursElapsed > 0.5 && hoursElapsed < 23.5) {
        const scale = 24 / hoursElapsed;
        const keys = ['agents', 'checkins', 'messages', 'sats'];
        for (const k of keys) {
          const delta = (last[k] || 0) - (prev[k] || 0);
          if (delta > 0) {
            last[k] = Math.round((prev[k] || 0) + delta * scale);
          }
        }
        // Density is a point-in-time count, not cumulative — don't project it
        last.projected = true;
        last.hoursElapsed = Math.round(hoursElapsed * 10) / 10;
      }
    }

    const result = { timeline, generated: now };

    // Cache timeline
    if (kv) {
      try {
        await kv.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL });
      } catch (e) { /* continue */ }
    }

    return Response.json(result, { headers: HEADERS });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
