// githubWriter.js
//
// Writes a new watched-wallet entry directly to known-exchange-wallets.json
// on GitHub, via their Contents API — replacing the manual "copy snippet,
// paste into GitHub, hope the JSON stays valid" workflow that broke three
// separate times from hand-editing (a stray comment, a deleted wrapper
// key, a missing brace).
//
// The key difference that makes this safe: this reads the file, merges
// the new entry as a real JavaScript object operation (config.watchedWallets[ticker]
// = {...}), then JSON.stringifies the whole thing back — which CANNOT
// produce invalid JSON, unlike a human editing raw text by hand.
//
// Needs a GitHub Personal Access Token with write access — see README for
// how to create one scoped as narrowly as possible (just this repo,
// just Contents read/write).

const GITHUB_API = "https://api.github.com";
const FILE_PATH = "known-exchange-wallets.json";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getConfig() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    return {
      ok: false,
      reason: "GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO not set",
    };
  }
  return { ok: true, token, owner, repo };
}

async function saveWatchedWallet({ ticker, chainId, address }) {
  const cfg = getConfig();
  if (!cfg.ok) return cfg;

  const { token, owner, repo } = cfg;
  const apiUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1. Fetch the current file + its sha (needed to commit an update)
  let currentSha, currentConfig;
  try {
    const getRes = await fetchWithTimeout(apiUrl, { headers });
    if (!getRes.ok) {
      const body = await getRes.text().catch(() => "");
      return { ok: false, reason: `GitHub GET ${getRes.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const getData = await getRes.json();
    currentSha = getData.sha;
    const decoded = Buffer.from(getData.content, "base64").toString("utf8");
    currentConfig = JSON.parse(decoded);
  } catch (err) {
    return { ok: false, reason: `Failed to fetch/parse current file: ${err.message}` };
  }

  // 2. Merge the new entry as a real object operation — this is what
  // guarantees valid JSON output, unlike hand-editing raw text.
  if (!currentConfig.watchedWallets) currentConfig.watchedWallets = {};
  const tickerKey = ticker.toUpperCase();
  const existing = currentConfig.watchedWallets[tickerKey];

  if (existing && Array.isArray(existing.addresses)) {
    // Ticker already has an entry — append this address if not already present
    if (!existing.addresses.includes(address)) {
      existing.addresses.push(address);
    }
    // Keep the existing chainId unless it wasn't set
    if (!existing.chainId) existing.chainId = chainId;
  } else {
    currentConfig.watchedWallets[tickerKey] = { chainId, addresses: [address] };
  }

  const newContent = JSON.stringify(currentConfig, null, 2) + "\n";
  const newContentBase64 = Buffer.from(newContent, "utf8").toString("base64");

  // 3. Commit the update back to GitHub
  try {
    const putRes = await fetchWithTimeout(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Add watched wallet for ${tickerKey} (via UNLOCK-01 dashboard)`,
        content: newContentBase64,
        sha: currentSha,
      }),
    });
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      return { ok: false, reason: `GitHub PUT ${putRes.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Failed to commit update: ${err.message}` };
  }
}

module.exports = { saveWatchedWallet };
