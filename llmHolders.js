// llmHolders.js
//
// Uses Claude (Anthropic API, with the web_search tool) to look up a
// token's current top holders directly from a block explorer page.
//
// IMPORTANT — this is fundamentally different from every other data source
// in this app: it's a best-effort LLM READ of a rendered webpage, not a
// structured API response. Etherscan's own tokenholderlist endpoint (Pro
// tier) would return guaranteed-accurate numbers; this instead asks Claude
// to search, read, and transcribe a table. Treat results as a supplementary
// hint, never as verified fact — the UI must always label this section
// "AI-sourced, unverified" and it must never gate or block a trade setup.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// LLM + web search round-trips are much slower than a direct API call, so
// this gets a longer timeout than the Binance/DropsTab/Etherscan calls.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getLlmTokenHolders(ticker) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: "ANTHROPIC_API_KEY not set" };

  const model = process.env.CLAUDE_HOLDER_MODEL || DEFAULT_MODEL;

  const prompt = `Identify the blockchain and contract address for the cryptocurrency with ticker symbol "${ticker}" (it trades as a ${ticker}USDT perpetual futures pair on Binance). Then look up that token's "Holders" / "Top Holders" tab on the appropriate block explorer (Etherscan for Ethereum, BscScan for BNB Chain, or the equivalent explorer for other EVM chains), and report the top 8 holder addresses currently shown there.

Respond with ONLY a JSON object — no other text, no markdown code fences — in exactly this shape:
{"chain": "ethereum", "contractAddress": "0x...", "holders": [{"address": "0x...", "percentage": 12.34, "label": "exchange wallet or team/vesting or null"}]}

If you cannot confidently find this data, respond with exactly: {"error": "brief reason"}`;

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
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      },
      25000
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

    // Strip markdown fences, then extract the JSON object even if the model
    // added a preamble before it despite instructions not to.
    const cleaned = textBlocks.replace(/```json|```/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : cleaned;

    let parsed;
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch (parseErr) {
      console.error(
        `[llm-holders] ${ticker}: couldn't parse JSON from Claude's response — raw text:`,
        cleaned.slice(0, 500)
      );
      return { ok: false, reason: "Could not parse holder data from Claude's response" };
    }

    if (parsed.error) {
      return { ok: false, reason: parsed.error };
    }

    if (!Array.isArray(parsed.holders) || parsed.holders.length === 0) {
      console.error(
        `[llm-holders] ${ticker}: response had no usable holders array — raw:`,
        JSON.stringify(parsed).slice(0, 500)
      );
      return { ok: false, reason: "No holder data found in Claude's response" };
    }

    return {
      ok: true,
      chain: parsed.chain || null,
      contractAddress: parsed.contractAddress || null,
      holders: parsed.holders,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { getLlmTokenHolders };
