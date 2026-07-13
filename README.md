# UNLOCK-01

Pre-unlock/airdrop short-setup scanner. Standalone agent — separate Railway
service from your other 24 Gecko agents, own dashboard, own HERALD sender.
Nothing auto-executes; every trade is manual, in your hands.

## What it actually does, honestly

| Step you asked for | What's real | What it needs |
|---|---|---|
| 1. Pick 3 unlocking tokens with a live Binance perp | Press **SUGGEST FROM DROPSTAB** to auto-fill from their real unlock calendar, cross-checked against a live Binance perp automatically — or type tickers in yourself if you'd rather pick manually | Same DropsTab key as step 2 (using the auto-fill button is optional; typing tickers manually is not) |
| 2. Trace tokenomics/TVL | Market cap, FDV, supply from DropsTab (same subscription as the unlock calendar) | Same DropsTab key as above — no separate CoinGecko key needed |
| 3. "Verify" MM price ceiling | Reframed honestly as a **squeeze-probability score** (funding rate + order book skew + recent price move + DropsTab's VWAP Score) — no data source can verify a market maker's intent, so this is a heuristic, not a fact. VWAP integration is best-effort: the endpoint is only documented in a third-party tutorial, not DropsTab's official docs, so it degrades gracefully if the URL/fields don't match | Same DropsTab key — uses their VWAP Radar endpoint |
| 4. Always-short setup, 2-3 tranches | Generated mechanically from price + volatility (ATR), gated so it's only shown when the squeeze score clears a minimum bar — see `scoring.js` for the veto logic | Nothing extra |
| 5. Wallet-to-exchange tracing | Works, but only for tickers where you've filled in `known-exchange-wallets.json` yourself — see that file's comments for why I didn't pre-fill addresses | One free Etherscan key (covers ETH, BSC, and 60+ other chains) + your own research |

## One-time setup

1. **DropsTab** (needed for tokenomics *and* the unlock calendar): sign up
   at [dropstab.com/products/commercial-api](https://dropstab.com/products/commercial-api).
   Basic tier ($19/mo) covers both features used here — auth is a Bearer
   token, grab it from your DropsTab account dashboard.
2. **HERALD email**: same pattern as SUPREME-LEADER — a Gmail App Password
   from [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. *(Optional, later)* **Etherscan**: one free key at etherscan.io/apis, for
   wallet tracing. This single key covers Ethereum, BSC, and 60+ other EVM
   chains via Etherscan's unified API V2 — no separate BscScan signup
   needed, that system was retired in 2025.

## Deploy (same routine as your other Gecko agents)

1. Create a new GitHub repo (e.g. `unlock-01`) and upload every file from
   this folder directly to the repo root — all files are flat, no
   subfolders, specifically so nothing can get lost or restructured during
   upload: `server.js`, `dataSources.js`, `scoring.js`, `tradeSetup.js`,
   `walletTrace.js`, `history.js`, `mailer.js`, `index.html`,
   `known-exchange-wallets.json`, `package.json`, `railway.toml`,
   `.env.example`, `README.md`.
2. Railway → **New** → **GitHub Repo** → select `unlock-01`.
3. Railway → your new service → **Variables** → paste in the values from
   `.env.example` (your real keys, not the blank template).
4. Railway redeploys automatically once variables are saved.
5. Railway → **Settings** → **Networking** → **Generate Domain** → make sure
   the target port is **8080**.
6. Open the generated domain — you'll see the UNLOCK-01 dashboard.

## Daily use

1. Press **SUGGEST FROM DROPSTAB** to auto-fill tickers unlocking soon with
   a live Binance perp — or type your own picks in manually.
2. Review what's filled in (or typed) — the agent already filtered for a
   live Binance perp, but a glance never hurts.
3. Press **RUN SCAN**.
4. Report renders on screen and lands in your inbox via HERALD at the same
   time.
5. You take (or skip) the trade manually on Binance.

## Worth doing after a couple of weeks of real trades

`history.json` keeps every report with a timestamp. Once you've got
real fills to compare against, it's worth checking whether the squeeze
score actually correlated with the setups that worked — that's the honest
way to know if this edge is real before scaling budget or leverage on it.

## Wallet tracing setup (step 5)

`known-exchange-wallets.json` already ships with verified Binance hot
wallet addresses for both Ethereum and BSC (confirmed live on Etherscan/
BscScan under the "Binance" / "Exchange" label) — the `exchangeWallets`
half is done, nothing to do there.

The `watchedWallets` half — the unlock-recipient address for whichever
token you're scanning — is different for every token, so it has to be
added per ticker before you run a scan:

1. On the token's Etherscan (or BscScan) page, open the **Contract** tab
   → find the vesting/token-lock contract address, or look at the
   **Token Holders** list for wallets holding a large, round percentage of
   supply (team/investor allocations are usually easy to spot this way)
2. Alternatively, check the token's page on tokenomist.ai — many list the
   allocation category and sometimes the recipient address directly
3. Add it to the config:

```json
"watchedWallets": {
  "ARB": { "chainId": 1, "addresses": ["0x...the address you found..."] }
}
```

4. Commit that change to GitHub — Railway redeploys automatically

If you skip this for a given ticker, the scan still runs fine — it just
shows "No watched wallets configured for this ticker" for step 5 instead
of a wallet-trace result, and steps 1-4 work exactly the same either way.
