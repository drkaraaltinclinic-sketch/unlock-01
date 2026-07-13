// scoring.js
// Turns raw market data into a "squeeze probability" score (0-100) and a
// conviction gate for the short thesis. This is a heuristic built from
// proxy signals — it does NOT verify market maker intent (nothing can).
// It flags conditions traders associate with pre-unlock price pumps /
// short squeezes so the setup isn't fired blindly into a crowded trade.

function scoreSqueezeProbability({ fundingRate, imbalance, priceChange24hPct, vwapScore }) {
  let score = 0;
  const notes = [];

  if (fundingRate == null && imbalance == null && priceChange24hPct == null && vwapScore == null) {
    notes.push("No funding/order-book/price/VWAP data available — score is uninformative, not a real reading of zero");
  }

  // Positive funding = longs paying shorts = crowd is leaning long.
  // Elevated positive funding ahead of an unlock is a classic pre-squeeze tell.
  if (fundingRate != null) {
    if (fundingRate > 0.0005) {
      score += 30;
      notes.push(`Funding rate elevated positive (${(fundingRate * 100).toFixed(3)}%) — crowd leaning long`);
    } else if (fundingRate > 0.0001) {
      score += 15;
      notes.push(`Funding rate mildly positive (${(fundingRate * 100).toFixed(3)}%)`);
    } else if (fundingRate < -0.0003) {
      score -= 10;
      notes.push(`Funding rate negative — crowd already leaning short, squeeze risk lower`);
    }
  }

  // Order book bid-heavy near the top = thin resistance above, easier push up.
  if (imbalance != null) {
    if (imbalance > 0.2) {
      score += 25;
      notes.push(`Order book bid-heavy (imbalance ${(imbalance * 100).toFixed(1)}%) — thin resistance above`);
    } else if (imbalance > 0.05) {
      score += 10;
      notes.push(`Order book mildly bid-heavy`);
    }
  }

  // Sharp recent pump into the unlock date is itself a squeeze/attention signal.
  if (priceChange24hPct != null) {
    if (priceChange24hPct > 8) {
      score += 25;
      notes.push(`Price up ${priceChange24hPct.toFixed(1)}% in 24h — already running into the unlock`);
    } else if (priceChange24hPct > 3) {
      score += 10;
      notes.push(`Price up ${priceChange24hPct.toFixed(1)}% in 24h`);
    }
  }

  // DropsTab VWAP Score: ((price - VWAP) / VWAP) * 100. Near +100 means
  // the price has run well above its volume-weighted fair value — the
  // clearest direct read of "overheated" among all these signals. Near
  // -100 means undervalued, which argues against the squeeze thesis.
  if (vwapScore != null) {
    if (vwapScore >= 80) {
      score += 35;
      notes.push(`VWAP Score ${vwapScore.toFixed(0)} — extremely overheated vs volume-weighted fair value`);
    } else if (vwapScore >= 50) {
      score += 20;
      notes.push(`VWAP Score ${vwapScore.toFixed(0)} — overheated vs volume-weighted fair value`);
    } else if (vwapScore <= -50) {
      score -= 15;
      notes.push(`VWAP Score ${vwapScore.toFixed(0)} — undervalued vs VWAP, weighs against the squeeze thesis`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  let label = "Low";
  if (score >= 65) label = "High";
  else if (score >= 35) label = "Moderate";

  return { score, label, notes };
}

// Conviction gate: mirrors the veto pattern from your Gecko constitution.
// Returns whether the setup should actually be surfaced as a trade idea,
// or just shown as informational.
function gateConviction({ squeezeScore, perpListed, tokenomicsOk, tokenomicsReason }) {
  const vetoes = [];
  if (!perpListed) vetoes.push("No live Binance perpetual for this ticker");
  if (!tokenomicsOk)
    vetoes.push(
      `Tokenomics data incomplete${tokenomicsReason ? ` — ${tokenomicsReason}` : ""}`
    );
  if (squeezeScore < 20)
    vetoes.push(`Squeeze-probability too low (score ${squeezeScore}) to justify a short bias today`);

  return { cleared: vetoes.length === 0, vetoes };
}

module.exports = { scoreSqueezeProbability, gateConviction };
