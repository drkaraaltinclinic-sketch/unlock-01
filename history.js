// history.js
// Append-only log of each scan's report, so you can look back and
// check whether the squeeze thesis / short setups actually played out.

const fs = require("fs");
const path = require("path");

const HISTORY_PATH = path.join(__dirname, "history.json");

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function appendReport(report) {
  const history = loadHistory();
  history.unshift({ ...report, savedAt: new Date().toISOString() });
  // keep last 200 reports
  const trimmed = history.slice(0, 200);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
  return trimmed[0];
}

function getRecent(limit = 20) {
  return loadHistory().slice(0, limit);
}

module.exports = { appendReport, getRecent };
