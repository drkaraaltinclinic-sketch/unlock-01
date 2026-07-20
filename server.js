require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const ds = require("./dataSources");
const { scoreSqueezeProbability, gateConviction } = require("./scoring");
const { generateShortSetup } = require("./tradeSetup");
const { checkWalletTransfers } = require("./walletTrace");
const { appendReport, getRecent } = require("./history");
const { sendHeraldReport } = require("./mailer");
const { getLlmTokenHolders } = require("./llmHolders");
const { saveWatchedWallet } = require("./githubWriter");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 8080;
// Captured once at process start — a fresh value here means a new
// deployment actually booted, which is what lets the dashboard detect
// "the redeploy finished" without needing any Railway API access.
const SERVER_STARTED_AT = new Date().toISOString();

async function analyzeTicker(ticker, includeLlmHolders) {
  const perp = await ds.hasBinancePerp(ticker);
  if (!perp.ok || !perp.listed) {
    return {
      ticker,
      cleared: false,
      vetoes: [perp.ok ? "No live Binance perpetual for this ticker" : perp.reason],
    };
  }
  const symbol = perp.symbol;

  const [funding, oi, book, klines, tokenomics, vwap] = await Promise.all([
    ds.getFundingRate(symbol),
    ds.getOpenInterest(symbol),
    ds.getOrderBookImbalance(symbol),
    ds.getRecentKlines(symbol, "1h", 24),
    ds.getTokenomics(ticker),
    ds.getVwapScore(ticker, "7d"),
  ]);

  // Log every failed source to Railway's Deploy Logs, so the real reason
  // is always visible there even if the UI only shows a short summary.
  for (const [name, result] of [
    ["funding", funding],
    ["openInterest", oi],
    ["orderBook", book],
    ["klines", klines],
    ["tokenomics", tokenomics],
    ["vwap", vwap],
  ]) {
    if (!result.ok) console.error(`[${ticker}] ${name} unavailable: ${result.reason}`);
  }

  // Opt-in only — this is the slowest and only per-call-cost data source,
  // so it never fires unless explicitly requested for this scan.
  let llmHolders = null;
  if (includeLlmHolders) {
    llmHolders = await getLlmTokenHolders(ticker);
    if (!llmHolders.ok) console.error(`[${ticker}] llmHolders unavailable: ${llmHolders.reason}`);
  }

  const atr = klines.ok ? ds.computeATR(klines.candles) : null;
  const priceChange24hPct =
    klines.ok && klines.candles.length > 1
      ? ((klines.candles[klines.candles.length - 1].close - klines.candles[0].close) /
          klines.candles[0].close) *
        100
      : null;

  const squeeze = scoreSqueezeProbability({
    fundingRate: funding.ok ? funding.fundingRate : null,
    imbalance: book.ok ? book.imbalance : null,
    priceChange24hPct,
    vwapScore: vwap.ok ? vwap.score : null,
  });

  const gate = gateConviction({
    squeezeScore: squeeze.score,
    perpListed: true,
    tokenomicsOk: tokenomics.ok,
    tokenomicsReason: tokenomics.ok ? null : tokenomics.reason,
  });

  const walletTrace = await checkWalletTransfers(ticker);

  if (!gate.cleared) {
    return {
      ticker,
      cleared: false,
      vetoes: gate.vetoes,
      squeeze,
      tokenomics,
      vwap: vwap.ok ? vwap : null,
      walletTrace,
      llmHolders, // pass through as-is (success, failure+reason, or null if not requested)
    };
  }

  const markPrice = funding.ok ? funding.markPrice : tokenomics.ok ? tokenomics.price : null;
  const setup = generateShortSetup({ markPrice, atr, squeezeScore: squeeze.score });

  return {
    ticker,
    symbol,
    cleared: !!setup,
    vetoes: setup ? [] : ["Insufficient price/ATR data to size a setup"],
    squeeze,
    tokenomics: tokenomics.ok ? tokenomics : null,
    tvl: null,
    funding: funding.ok ? funding : null,
    orderBook: book.ok ? book : null,
    vwap: vwap.ok ? vwap : null,
    walletTrace,
    llmHolders, // pass through as-is (success, failure+reason, or null if not requested)
    setup,
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    agent: "UNLOCK-01",
    status: "online",
    startedAt: SERVER_STARTED_AT,
    configured: {
      dropstab: !!process.env.DROPSTAB_API_KEY,
      etherscan: !!process.env.ETHERSCAN_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      moralis: !!process.env.MORALIS_API_KEY,
      github: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO),
      herald: !!(process.env.HERALD_GMAIL_USER && process.env.HERALD_GMAIL_APP_PASSWORD),
    },
  });
});

app.post("/api/scan", async (req, res) => {
  try {
    const tickers = (req.body.tickers || [])
      .map((t) => String(t).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);

    if (tickers.length === 0) {
      return res.status(400).json({
        error:
          "No tickers provided. Check tokenomist.ai's free unlock calendar for tomorrow's unlocks, then enter up to 3 tickers.",
      });
    }

    const includeLlmHolders = !!req.body.includeLlmHolders;
    const tokens = await Promise.all(tickers.map((t) => analyzeTicker(t, includeLlmHolders)));

    const report = {
      generatedAt: new Date().toISOString(),
      tokens,
    };

    const saved = appendReport(report);

    let heraldResult = { ok: false, reason: "not requested" };
    if (req.body.sendHerald) {
      heraldResult = await sendHeraldReport(report);
      if (!heraldResult.ok) {
        console.error(`[herald] send failed: ${heraldResult.reason}`);
      }
    }

    res.json({ report: saved, herald: heraldResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/unlocks", async (req, res) => {
  try {
    const unlocks = await ds.getUpcomingUnlocks(48);
    if (!unlocks.ok) {
      return res.json({ ok: false, reason: unlocks.reason, suggestions: [] });
    }

    // Cross-check each upcoming unlock against a live Binance perp, and
    // return the first 3 that actually have one.
    const suggestions = [];
    for (const event of unlocks.events) {
      if (suggestions.length >= 3) break;
      const perp = await ds.hasBinancePerp(event.ticker);
      if (perp.ok && perp.listed) {
        suggestions.push({ ticker: event.ticker, date: event.dateStr, percentage: event.percentage });
      }
    }

    res.json({ ok: true, suggestions, totalUnlocksSeen: unlocks.totalEventsSeen });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message, suggestions: [] });
  }
});

app.post("/api/save-watched-wallet", async (req, res) => {
  try {
    const { ticker, chainId, address } = req.body;
    if (!ticker || !chainId || !address) {
      return res.status(400).json({ ok: false, reason: "ticker, chainId, and address are all required" });
    }
    const result = await saveWatchedWallet({ ticker: String(ticker), chainId: Number(chainId), address: String(address) });
    if (!result.ok) console.error(`[github-writer] save failed for ${ticker}: ${result.reason}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

app.get("/api/gainers", async (req, res) => {
  try {
    const result = await ds.getTopGainers(3);
    if (!result.ok) {
      return res.json({ ok: false, reason: result.reason, suggestions: [] });
    }
    const suggestions = result.gainers.map((g) => ({
      ticker: g.ticker,
      priceChangePercent: g.priceChangePercent,
    }));
    res.json({ ok: true, suggestions });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message, suggestions: [] });
  }
});

app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  res.json(getRecent(limit));
});

app.listen(PORT, () => {
  console.log(`UNLOCK-01 listening on port ${PORT}`);
});
