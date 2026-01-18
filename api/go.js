// go.js (Vercel serverless function / api route)
// Handles redirects for expiring links.
//
// This code expects:
// - a storage layer where codes map to { url, expiresAt }
// - if expired or missing, show an expired page
//
// NOTE: This file was provided by user; below is full content with only expired view text adjusted.

import crypto from "crypto";

/**
 * Minimal in-memory store fallback (NOT for production).
 * In production, this should be KV/DB.
 */
const mem = globalThis.__TEMPQR_MEM__ || (globalThis.__TEMPQR_MEM__ = new Map());

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    body{
      margin:0;
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background:#0b0f14;
      color:#e5e7eb;
      display:flex;
      align-items:center;
      justify-content:center;
      height:100vh;
      padding:18px;
    }
    .card{
      width:min(720px, 95vw);
      background: linear-gradient(180deg, rgba(17,24,39,0.85), rgba(15,23,42,0.85));
      border:1px solid rgba(255,255,255,0.08);
      border-radius:16px;
      padding:18px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.45);
      text-align:center;
    }
    h1{ margin:0 0 8px; font-size:28px; }
    p{ margin:8px 0 0; color: rgba(229,231,235,0.72); line-height:1.6; }
    a{ color:#38bdf8; text-decoration:none; }
    a:hover{ text-decoration:underline; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}

function expiredHTML() {
  return htmlPage(
    "TempQR — Expired",
    `<h1>Link expired</h1>
  <p>This temporary link is no longer available.</p>
  <p>TempQR does not keep history, logs, or archives. Once it expires &mdash; it&rsquo;s gone.</p>
  <p><a href="/">Go back</a></p>`
  );
}

function getCodeFromRequest(req) {
  try {
    const u = new URL(req.url);
    const path = u.pathname || "/";
    // Expect /go/<code> or /<code> depending on vercel routing
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0] === "go" && parts[1]) return parts[1];
    return parts[0];
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const code = getCodeFromRequest(req);
    if (!code) {
      res.status(302).setHeader("Location", "/");
      res.end();
      return;
    }

    const item = mem.get(code);
    if (!item) {
      res.status(410).setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(expiredHTML());
      return;
    }

    const now = Date.now();
    if (item.expiresAt && now >= item.expiresAt) {
      // expire and delete
      mem.delete(code);
      res.status(410).setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(expiredHTML());
      return;
    }

    res.status(302).setHeader("Location", item.url);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(htmlPage("TempQR — Error", "<h1>Something went wrong</h1><p>Please try again.</p>"));
  }
}
