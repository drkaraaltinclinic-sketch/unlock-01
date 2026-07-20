// llmHolders.js
//
// Two-stage token holder lookup, redesigned after the pure-LLM approach hit
// a real wall: block explorer "Holders" tabs are JavaScript-rendered, so an
// LLM's web_search tool (which only sees the raw pre-render HTML) could
// never reliably read them. Splitting the job by what each tool is
// actually good at:
//
//   Stage 1 — Claude + web_search resolves ticker -> {chain, contractAddress}.
//   This is a good fit for search: contract addresses are plain, indexable
//   text on CoinGecko/CoinMarketCap pages and project docs, not a rendered
//   table. Still a best-effort LLM step — verify the returned address
//   against what you see on Binance/CoinGecko before fully trusting it.
//
//   Stage 2 — Moralis's real Token Owners API (deep-index.moralis.io)
//   returns the actual top holders as structured JSON, pre-labeled with
//   known exchange/entity names by Moralis itself — not an LLM guess.
//   Free Starter plan: 40,000 CU/day, this endpoint costs 50 CU/call,
//   so roughly 800 calls/day headroom — far more than a personal scan
//   tool needs.
//
// Net effect: the holder *numbers* are now genuinely structured/verified.
// The only remaining LLM-dependent step is contract-address resolution,
// which is why the UI still shows the resolved address for you to
// eyeball-confirm, and still carries a lighter-touch caution label.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MORALIS_API = "https://deep-index.moralis.io/api/v2.2";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const MORALIS_CHAIN_MAP = {
  ethereum: "eth",
  eth: "eth",
  mainnet: "eth",
  "ethereum mainnet": "eth",
  bsc: "bsc",
  bnb: "bsc",
  "bnb chain": "bsc",
  "bnb smart chain": "bsc",
  "binance smart chain": "bsc",
  "binance chain": "bsc",
  polygon: "polygon",
  matic: "polygon",
  arbitrum: "arbitrum",
  "arbitrum one": "arbitrum",
  base: "base",
  optimism: "optimism",
  op: "optimism",
  avalanche: "avalanche",
  avax: "avalanche",
  cronos: "cronos",
  gnosis: "gnosis",
  linea: "linea",
};

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Stage 1: Claude + web_search resolves ticker -> contract address ──

async function resolveContractAddress(ticker) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: "ANTHROPIC_API_KEY not set" };

  const model = process.env.CLAUDE_HOLDER_MODEL || DEFAULT_MODEL;

  const prompt = `Identify the blockchain and contract address for the cryptocurrency with ticker symbol "${ticker}" (it trades as a ${ticker}USDT perpetual futures pair on Binance). Contract addresses are normally listed in plain text on the token's CoinGecko page, CoinMarketCap page, or official project docs — look there.

Respond with ONLY a JSON object — no other text, no markdown code fences — in exactly this shape:
{"chain": "ethereum", "contractAddress": "0x..."}

If you cannot confidently find this, respond with exactly: {"error": "brief reason"}`;

  try {
    const res = await fetchWithTimeout(
      ANTHROPIC_API,
      {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          messages: [{ role: "user", content: prompt }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      },
      20000
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `Claude API ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }

    const data = await res.json();
    const textBlocks = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const cleaned = textBlocks.replace(/```json|```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : cleaned;

    let parsed;
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch (parseErr) {
      console.error(`[holder-lookup] ${ticker}: couldn't parse contract-resolution JSON — raw:`, cleaned.slice(0, 500));
      return { ok: false, reason: "Could not parse contract address from Claude's response" };
    }

    if (parsed.error) return { ok: false, reason: parsed.error };
    if (!parsed.chain || !parsed.contractAddress) {
      return { ok: false, reason: "Claude's response was missing chain or contractAddress" };
    }

    return { ok: true, chain: parsed.chain, contractAddress: parsed.contractAddress };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Stage 2: Moralis's real Token Owners API — structured, pre-labeled ──

async function getMoralisTopHolders(chain, contractAddress, limit = 8) {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return { ok: false, reason: "MORALIS_API_KEY not set" };

  const chainKey = chain.toLowerCase().trim();
  const moralisChain = MORALIS_CHAIN_MAP[chainKey] || chainKey;
  if (!MORALIS_CHAIN_MAP[chainKey]) {
    console.error(`[holder-lookup] chain "${chain}" not in MORALIS_CHAIN_MAP — passing through as "${moralisChain}" and hoping it matches Moralis's enum. Add it to the map if this fails.`);
  }

  try {
    const res = await fetchWithTimeout(
      `${MORALIS_API}/erc20/${contractAddress}/owners?chain=${encodeURIComponent(moralisChain)}&limit=${limit}&order=DESC`,
      { headers: { "X-API-Key": key } },
      15000
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `Moralis ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const data = await res.json();
    const result = Array.isArray(data.result) ? data.result : [];
    const holders = result.map((h) => ({
      address: h.owner_address,
      percentage: h.percentage_relative_to_total_supply,
      label: h.owner_address_label || h.entity || null,
      usdValue: h.usd_value || null,
    }));
    return { ok: true, holders, totalSupply: data.total_supply || null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── Combined pipeline — same exported shape as before, so server.js and
// index.html need no changes at all ──

async function getLlmTokenHolders(ticker) {
  const resolved = await resolveContractAddress(ticker);
  if (!resolved.ok) return resolved;

  const holdersResult = await getMoralisTopHolders(resolved.chain, resolved.contractAddress, 8);
  if (!holdersResult.ok) {
    return { ok: false, reason: `resolved ${ticker} to ${resolved.contractAddress} on ${resolved.chain}, but Moralis lookup failed: ${holdersResult.reason}` };
  }

  return {
    ok: true,
    chain: resolved.chain,
    contractAddress: resolved.contractAddress,
    holders: holdersResult.holders,
  };
}

module.exports = { getLlmTokenHolders };
