// mailer.js
// UNLOCK-01's own HERALD sender — separate nodemailer instance from
// SUPREME-LEADER's, so this fires independently whenever you press the
// button, regardless of what the other 24 agents are doing.

const nodemailer = require("nodemailer");

function getTransport() {
  const user = process.env.HERALD_GMAIL_USER;
  const pass = process.env.HERALD_GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

function formatReportHtml(report) {
  const rows = report.tokens
    .map((t) => {
      if (!t.cleared) {
        return `<tr><td colspan="5" style="padding:8px;border-bottom:1px solid #333;color:#999;">
          <b>${t.ticker}</b> — skipped (${t.vetoes.join("; ")})</td></tr>`;
      }
      const s = t.setup;
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #333;"><b>${t.ticker}</b></td>
          <td style="padding:8px;border-bottom:1px solid #333;">Squeeze: ${t.squeeze.label} (${t.squeeze.score})</td>
          <td style="padding:8px;border-bottom:1px solid #333;">Entries: ${s.entries
            .map((e) => e.price)
            .join(" / ")}</td>
          <td style="padding:8px;border-bottom:1px solid #333;">SL: ${s.stopLoss}</td>
          <td style="padding:8px;border-bottom:1px solid #333;">TP: ${s.takeProfit.join(" / ")}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family:monospace;background:#0a0b0d;color:#e6e4df;padding:20px;">
      <h2 style="color:#d9a441;">UNLOCK-01 — Scan Report</h2>
      <p style="color:#797e87;">${new Date(report.generatedAt).toLocaleString()}</p>
      <table style="border-collapse:collapse;width:100%;">${rows}</table>
      <p style="color:#797e87;margin-top:16px;">Manual review only — no auto-execution. Check current market conditions on Binance before entering.</p>
    </div>`;
}

async function sendHeraldReport(report) {
  const transport = getTransport();
  if (!transport) {
    return { ok: false, reason: "HERALD_GMAIL_USER / HERALD_GMAIL_APP_PASSWORD not set" };
  }
  const to = process.env.HERALD_RECIPIENT || process.env.HERALD_GMAIL_USER;
  try {
    await transport.sendMail({
      from: process.env.HERALD_GMAIL_USER,
      to,
      subject: `UNLOCK-01 Scan Report — ${new Date(report.generatedAt).toLocaleDateString()}`,
      html: formatReportHtml(report),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { sendHeraldReport };
