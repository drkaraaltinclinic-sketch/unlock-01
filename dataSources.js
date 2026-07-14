// dataSources.js
// All external API calls live here. Every function is defensive:
// if a source isn't configured or fails, it returns { ok:false, reason }
// instead of throwing, so one bad source never kills the whole scan.

const FAPI = "https://fapi.binance.com";

let _perpSymbolCache = null;
let _perpCacheAt = 0;

// Every external call goes through this so a slow/unreachable API can
// never hang the request indefinitely — fails fast instead, and the
// pipeline's try/catch blocks turn that into a graceful "source unavailable"
// rather than a dead request.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Binance Futures (public, no key needed) ─────────────────────

async function getPerpSymbolSet() {
  const now = Date.now();
  if (_perpSymbolCache && now - _perpCacheAt < 10 * 60 * 1000) {
    return _perpSymbolCache;
  }
  const res = await fetchWithTimeout(`${FAPI}/fapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status}`);
  const json = await res.json();
  const set = new Set(
    json.symbols
      .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
      .map((s) => s.symbol)
  );
  _perpSymbolCache = set;
  _perpCacheAt = now;
  return set;
}

async function hasBinancePerp(ticker) {
  try {
    const set = await getPerpSymbolSet();
    const symbol = `${ticker.toUpperCase()}USDT`;
    return { ok: true, symbol, listed: set.has(symbol) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function getFundingRate(symbol) {
  try {
    const res = await fetchWithTimeout(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
    if (!res.ok) throw new Error(`premiumIndex ${res.status}`);
    const j = await res.json();
    return { ok: true, fundingRate: parseFloat(j.lastFundingRate), markPrice: parseFloat(j.markPrice) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function getOpenInterest(symbol) {
  try {
    const res = await fetchWithTimeout(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
    if (!res.ok) throw new Error(`openInterest ${res.status}`);
    const j = await res.json();
    return { ok: true, openInterest: parseFloat(j.openInterest) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function getOrderBookImbalance(symbol) {
  try {
    const res = await fetchWithTimeout(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=50`);
    if (!res.ok) throw new Error(`depth ${res.status}`);
    const j = await res.json();
    const bidVol = j.bids.reduce((s, [, q]) => s + parseFloat(q), 0);
    const askVol = j.asks.reduce((s, [, q]) => s + parseFloat(q), 0);
    const imbalance = (bidVol - askVol) / (bidVol + askVol || 1);
    return { ok: true, imbalance, bidVol, askVol };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function getRecentKlines(symbol, interval = "1h", limit = 24) {
  try {
    const res = await fetchWithTimeout(
      `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`klines ${res.status}`);
    const j = await res.json();
    // [openTime, open, high, low, close, volume, ...]
    const candles = j.map((c) => ({
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
    }));
    return { ok: true, candles };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function computeATR(candles) {
  if (!candles || candles.length < 2) return null;
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / (candles.length - 1);
}

// ── DropsTab (tokenomics) — same two-step pattern as before: resolve a
// ticker to DropsTab's internal slug, then pull detailed market data for
// that slug. Uses the same Basic-tier subscription as /tokenUnlocks, so
// no separate CoinGecko key is needed anymore.

async function searchDropstabSlug(ticker) {
  const key = process.env.DROPSTAB_API_KEY;
  if (!key) return { ok: false, reason: "DROPSTAB_API_KEY not set" };
  try {
    const res = await fetchWithTimeout(
      `${DROPSTAB_BASE}/coins/nonStrictSearch?query=${encodeURIComponent(ticker)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `dropstab search ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const j = await res.json();

    // Real shape confirmed from production logs: { status, data: { content: [...] } }
    // Kept the other guesses as fallbacks in case DropsTab's shape varies
    // by endpoint version, but data.content is the one that's actually real.
    let list = null;
    if (Array.isArray(j)) list = j;
    else if (j.data && Array.isArray(j.data.content)) list = j.data.content;
    else if (Array.isArray(j.data)) list = j.data;
    else if (Array.isArray(j.result)) list = j.result;
    else if (Array.isArray(j.items)) list = j.items;
    else if (Array.isArray(j.coins)) list = j.coins;
    else if (j.data && Array.isArray(j.data.items)) list = j.data.items;
    else if (j.data && Array.isArray(j.data.coins)) list = j.data.coins;
    else if (j.data && Array.isArray(j.data.results)) list = j.data.results;

    if (!list) {
      console.error(
        "[dropstab] nonStrictSearch response had no recognizable array field — raw sample:",
        JSON.stringify(j).slice(0, 500)
      );
      return { ok: false, reason: "DropsTab search response had no recognizable list of results" };
    }

    // Multiple different projects can share the same ticker symbol (seen in
    // production: two "SOLV" entries, only one actively trading) — among
    // exact symbol matches, prefer the one that's actually trading rather
    // than just taking whichever the API listed first.
    const exactMatches = list.filter(
      (c) => String(c.symbol || c.ticker || "").toLowerCase() === ticker.toLowerCase()
    );
    const match =
      exactMatches.find((c) => c.trading === "CURRENTLY_TRADING") || exactMatches[0];
    if (!match) {
      if (list.length > 0) {
        console.error(
          "[dropstab] search returned results but none matched on a symbol/ticker field — raw sample:",
          JSON.stringify(list[0]).slice(0, 500)
        );
      }
      return { ok: false, reason: "no DropsTab match for ticker" };
    }
    const slug = match.slug || match.coinSlug || match.id;
    if (!slug) {
      console.error("[dropstab] matched a coin but found no slug/coinSlug/id field — raw match:", JSON.stringify(match).slice(0, 500));
      return { ok: false, reason: "DropsTab match had no usable slug field" };
    }
    return { ok: true, slug };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function getTokenomics(ticker) {
  const slugResult = await searchDropstabSlug(ticker);
  if (!slugResult.ok) return slugResult;
  const key = process.env.DROPSTAB_API_KEY;
  try {
    const res = await fetchWithTimeout(`${DROPSTAB_BASE}/coins/detailed/${slugResult.slug}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `dropstab detailed ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const raw = await res.json();
    // Real shape confirmed from production logs: { status, data: { ... } }
    // — the actual coin object is nested under "data", not top-level.
    const d = (raw && typeof raw.data === "object" && raw.data) ? raw.data : raw;

    // price and marketCap are themselves objects keyed by currency, e.g.
    // { "USD": 0.00261, "BTC": ..., "ETH": ... } — confirmed from production
    // logs — not plain numbers like most other sources return.
    const unwrapUsd = (field) => {
      if (field == null) return null;
      if (typeof field === "number") return field;
      if (typeof field === "object" && field.USD != null) return field.USD;
      return null;
    };

    const price = unwrapUsd(d.price) ?? unwrapUsd(d.currentPrice) ?? unwrapUsd(d.priceUsd);
    const marketCap = unwrapUsd(d.marketCap) ?? unwrapUsd(d.market_cap);
    const fdv = unwrapUsd(d.fdv) ?? unwrapUsd(d.fullyDilutedValuation) ?? unwrapUsd(d.fullyDilutedMarketCap);
    const circulatingSupply = d.circulatingSupply ?? d.circulating_supply ?? d.supply?.circulating;
    const totalSupply = d.totalSupply ?? d.total_supply ?? d.supply?.total;
    const maxSupply = d.maxSupply ?? d.max_supply ?? d.supply?.max;

    if (price == null && marketCap == null) {
      console.error(
        "[dropstab] coins/detailed had no usable price/marketCap — top-level keys:",
        JSON.stringify(Object.keys(d)),
        "| price shape:", JSON.stringify(d.price),
        "| marketCap shape:", JSON.stringify(d.marketCap)
      );
      return { ok: false, reason: "DropsTab detailed response had no recognizable price/market-cap fields" };
    }

    if (fdv == null || circulatingSupply == null) {
      console.error(
        `[dropstab] ${ticker}: price/marketCap OK but fdv or supply missing — top-level keys:`,
        JSON.stringify(Object.keys(d))
      );
    }

    return { ok: true, price, marketCap, fdv, circulatingSupply, totalSupply, maxSupply };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── DefiLlama TVL (free, protocol-slug based — best effort) ─────

async function getTVL(protocolSlug) {
  if (!protocolSlug) return { ok: false, reason: "no protocol slug provided" };
  try {
    const res = await fetchWithTimeout(`https://api.llama.fi/tvl/${protocolSlug}`);
    if (!res.ok) throw new Error(`tvl ${res.status}`);
    const tvl = await res.json();
    if (typeof tvl !== "number") return { ok: false, reason: "no TVL for this protocol" };
    return { ok: true, tvl };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── DropsTab unlock calendar (their /tokenUnlocks endpoint is one of the
// only sources with real unlock-schedule data — CoinGecko, CoinMarketCap
// and DeFiLlama's free tiers don't carry this at all) ──────────────────

const DROPSTAB_BASE = "https://public-api.dropstab.com/api/v1";

async function getUpcomingUnlocks(withinHours = 48) {
  const key = process.env.DROPSTAB_API_KEY;
  if (!key) {
    return {
      ok: false,
      reason: "DROPSTAB_API_KEY not set — using manual ticker entry instead",
    };
  }
  try {
    const res = await fetchWithTimeout(`${DROPSTAB_BASE}/tokenUnlocks`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `dropstab ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const j = await res.json();
    const rawEvents = j.data || j.result || j.items || (Array.isArray(j) ? j : []);

    // DropsTab's exact field names for ticker/date aren't confirmed from
    // docs alone — try the common possibilities defensively, and keep the
    // raw object attached so a mismatch is visible in Railway's logs
    // instead of silently returning nothing.
    const now = Date.now();
    const cutoffMs = now + withinHours * 3600 * 1000;

    const parsed = rawEvents
      .map((e) => ({
        ticker: String(e.symbol || e.ticker || e.coinSymbol || "").toUpperCase(),
        dateStr: e.date || e.unlockDate || e.nextUnlockDate || e.eventDate,
        percentage: e.percentage ?? e.percentOfSupply ?? e.unlockPercentage ?? null,
        raw: e,
      }))
      .filter((e) => e.ticker && e.dateStr);

    const noTickerFieldCount = rawEvents.filter(
      (e) => !(e.symbol || e.ticker || e.coinSymbol)
    ).length;
    if (noTickerFieldCount > 0) {
      console.error(
        `[dropstab] ${noTickerFieldCount}/${rawEvents.length} events had no symbol/ticker/coinSymbol field (only a full name like "coin") — skipped rather than guessed, to avoid a false "no perp" result. Raw sample:`,
        JSON.stringify(rawEvents[0]).slice(0, 500)
      );
    }

    const upcoming = parsed
      .filter((e) => {
        const t = new Date(e.dateStr).getTime();
        return !isNaN(t) && t >= now && t <= cutoffMs;
      })
      .sort((a, b) => new Date(a.dateStr) - new Date(b.dateStr));

    if (rawEvents.length > 0 && parsed.length === 0) {
      console.error(
        "[dropstab] Got a response but couldn't find ticker/date fields on any event — raw sample:",
        JSON.stringify(rawEvents[0]).slice(0, 500)
      );
    }

    return { ok: true, events: upcoming, totalEventsSeen: rawEvents.length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── DropsTab VWAP Radar — VWAP Score = ((price - VWAP) / VWAP) * 100.
// Near +100 = overheated (price far above its volume-weighted fair value);
// near -100 = deep discount. This endpoint is only documented in a
// third-party tutorial, not DropsTab's own official API docs page, so the
// URL/field names here are a best guess — built defensively, and treated
// as a nice-to-have signal rather than something the scan depends on.
const DROPSTAB_VWAP_BASE = "https://api.dropstab.com";

async function getVwapScore(ticker, window = "7d") {
  const key = process.env.DROPSTAB_API_KEY;
  if (!key) return { ok: false, reason: "DROPSTAB_API_KEY not set" };
  try {
    const res = await fetchWithTimeout(
      `${DROPSTAB_VWAP_BASE}/vwapRadar?token=${encodeURIComponent(ticker)}&window=${window}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `dropstab vwap ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const j = await res.json();
    const score = j.score ?? j.vwapScore ?? j.data?.score;
    if (score == null) {
      console.error("[dropstab] vwapRadar response had no recognizable score field — raw sample:", JSON.stringify(j).slice(0, 500));
      return { ok: false, reason: "VWAP response had no recognizable score field" };
    }
    return { ok: true, score: Number(score) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  hasBinancePerp,
  getFundingRate,
  getOpenInterest,
  getOrderBookImbalance,
  getRecentKlines,
  computeATR,
  getTokenomics,
  getVwapScore,
  getTVL,
  getUpcomingUnlocks,
};
