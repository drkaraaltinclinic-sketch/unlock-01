// walletTrace.js
// Checks whether known unlock-recipient wallets (team/investor addresses)
// have moved funds to a labeled exchange deposit wallet — a real sell-
// pressure signal, using Etherscan's unified API V2 (covers Ethereum, BSC,
// and 60+ other EVM chains with a single API key via the chainid param —
// BscScan's separate key system was retired in 2025 and merged into this).
//
// IMPORTANT: known-exchange-wallets.json ships EMPTY on purpose. I'm not
// hardcoding exchange wallet addresses from memory into a tool that sizes
// real leveraged trades — a wrong address would silently give you false
// "no transfer detected" confidence. Populate it yourself from a source
// you trust:
//   - Etherscan "Label Word Cloud" → Exchange tag (free, public, no key):
//     https://etherscan.io/labelcloud  (covers both ETH and, via the same
//     account, other EVM chains — check the chain switcher on that page)
//   - Arkham Intelligence / Nansen once you're on a paid tier (auto-labels)
//
// unlock-recipient wallets (the "watched" addresses) also go in the same
// file — copy them from the project's vesting contract page on Etherscan,
// or from Tokenomist's per-token unlock page which usually lists them.

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "known-exchange-wallets.json");
const ETHERSCAN_V2_BASE = "https://api.etherscan.io/v2/api";

// Common EVM chain IDs, for reference when filling in the config file:
// Ethereum = 1, BNB Smart Chain = 56, Arbitrum = 42161, Optimism = 10,
// Base = 8453, Polygon = 137, Avalanche = 43114.

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { exchangeWallets: {}, watchedWallets: {} };
  }
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkWalletTransfers(ticker) {
  const config = loadConfig();
  const watched = config.watchedWallets[ticker.toUpperCase()];
  if (!watched || !watched.addresses || watched.addresses.length === 0) {
    return {
      ok: false,
      reason:
        "No watched wallets configured for this ticker in data/known-exchange-wallets.json — add the unlock recipient address(es) and chainId to enable this check",
    };
  }

  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) {
    return { ok: false, reason: "ETHERSCAN_API_KEY not set" };
  }

  const chainId = watched.chainId || 1;

  // Gather all configured exchange addresses on this same chain
  const exchangeAddrs = new Set();
  for (const group of Object.values(config.exchangeWallets)) {
    if (group.chainId === chainId) {
      for (const a of group.addresses || []) exchangeAddrs.add(a.toLowerCase());
    }
  }

  if (exchangeAddrs.size === 0) {
    return {
      ok: false,
      reason: `No exchange wallets configured for chainId ${chainId} in data/known-exchange-wallets.json — nothing to match transfers against`,
    };
  }

  const results = [];
  for (const addr of watched.addresses) {
    try {
      const url = `${ETHERSCAN_V2_BASE}?chainid=${chainId}&module=account&action=txlist&address=${addr}&sort=desc&offset=20&apikey=${key}`;
      const res = await fetchWithTimeout(url);
      const j = await res.json();
      const txs = j.result || [];
      const toExchange = Array.isArray(txs)
        ? txs.filter((tx) => exchangeAddrs.has((tx.to || "").toLowerCase()))
        : [];
      results.push({
        address: addr,
        chainId,
        recentTxCount: Array.isArray(txs) ? txs.length : 0,
        transfersToExchange: toExchange.length,
        lastTransferToExchange: toExchange[0]
          ? new Date(parseInt(toExchange[0].timeStamp, 10) * 1000).toISOString()
          : null,
      });
    } catch (err) {
      results.push({ address: addr, chainId, error: err.message });
    }
  }

  const anySignal = results.some((r) => r.transfersToExchange > 0);
  return { ok: true, results, sellPressureSignal: anySignal };
}

module.exports = { checkWalletTransfers };
