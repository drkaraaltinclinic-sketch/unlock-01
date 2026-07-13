// tradeSetup.js
// Generates a 2-3 tranche SHORT setup from price + ATR. This is a
// mechanical template (rules-based), not a guarantee — the squeeze score
// and conviction gate from scoring.js decide whether to surface it at all.

function generateShortSetup({ markPrice, atr, squeezeScore }) {
  if (!markPrice || !atr) return null;

  // More tranches / wider spread when squeeze probability is high,
  // since a high score means "expect a push up before it rolls over."
  const highSqueeze = squeezeScore >= 65;

  const entries = highSqueeze
    ? [
        { label: "Tranche 1", price: +(markPrice * 1.015).toFixed(6), sizePct: 30 },
        { label: "Tranche 2", price: +(markPrice * 1.035).toFixed(6), sizePct: 35 },
        { label: "Tranche 3", price: +(markPrice * 1.06).toFixed(6), sizePct: 35 },
      ]
    : [
        { label: "Tranche 1", price: +(markPrice * 1.008).toFixed(6), sizePct: 45 },
        { label: "Tranche 2", price: +(markPrice * 1.02).toFixed(6), sizePct: 55 },
      ];

  const avgEntry =
    entries.reduce((s, e) => s + e.price * (e.sizePct / 100), 0);

  const stopLoss = +(entries[entries.length - 1].price + atr * 1.5).toFixed(6);
  const takeProfit1 = +(avgEntry - atr * 2).toFixed(6);
  const takeProfit2 = +(avgEntry - atr * 3.5).toFixed(6);

  const riskPct = ((stopLoss - avgEntry) / avgEntry) * 100;
  const reward1Pct = ((avgEntry - takeProfit1) / avgEntry) * 100;
  const rr1 = Math.abs(reward1Pct / riskPct);

  return {
    direction: "SHORT",
    entries,
    avgEntry: +avgEntry.toFixed(6),
    stopLoss,
    takeProfit: [takeProfit1, takeProfit2],
    riskPct: +riskPct.toFixed(2),
    rewardToRisk: +rr1.toFixed(2),
    note:
      "Entries are staggered above current mark price to catch a squeeze/pump into the unlock; if price never reaches Tranche 1, no position is opened.",
  };
}

module.exports = { generateShortSetup };
