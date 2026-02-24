// api/go.js — ALWAYS return HTML (with OG tags) so chat preview uses our QR image.
// Then redirect real users via meta refresh + JS (bots won't execute JS).

export const config = { runtime: "edge" };

const HARMFUL_MSG = "Harmful URLs are not allowed.";

function b64urlToBytes(b64u) {
  const s = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacBytes(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return new Uint8Array(sig);
}

async function hmacB64url(payload, secret, truncBytes = null) {
  const bytes = await hmacBytes(payload, secret);
  const out = truncBytes ? bytes.subarray(0, truncBytes) : bytes;
  return bytesToB64url(out);
}

function parseV2Payload(bytes) {
  // [1 byte version=2][4 bytes expirySeconds BE][utf8 url bytes]
  if (!bytes || bytes.length < 6) return null;
  if (bytes[0] !== 2) return null;

  const expSec =
    ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;

  const urlBytes = bytes.subarray(5);
  const u = new TextDecoder().decode(urlBytes);
  if (!u) return null;

  return { u, eMs: expSec * 1000, v: 2 };
}

function parseV1Payload(bytes) {
  // v1 was base64url(JSON string) where JSON has {u, e, v}
  try {
    const str = new TextDecoder().decode(bytes);
    const obj = JSON.parse(str);
    if (!obj?.u || !obj?.e) return null;
    const eMs = new Date(obj.e).getTime();
    if (!Number.isFinite(eMs) || eMs <= 0) return null;
    return { u: obj.u, eMs, v: 1 };
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* --------- Harmful re-check on redirect (edge) ---------- */

function isIPv4(host) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function ipv4ToInt(host) {
  const parts = host.split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 4) return null;
  for (const p of parts) if (!Number.isFinite(p) || p < 0 || p > 255) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inRange(n, a, b) {
  return n != null && n >= a && n <= b;
}

function isPrivateIPv4(host) {
  const n = ipv4ToInt(host);
  if (n == null) return false;

  if (inRange(n, ipv4ToInt("10.0.0.0"), ipv4ToInt("10.255.255.255"))) return true;
  if (inRange(n, ipv4ToInt("127.0.0.0"), ipv4ToInt("127.255.255.255"))) return true;
  if (inRange(n, ipv4ToInt("172.16.0.0"), ipv4ToInt("172.31.255.255"))) return true;
  if (inRange(n, ipv4ToInt("192.168.0.0"), ipv4ToInt("192.168.255.255"))) return true;
  if (inRange(n, ipv4ToInt("169.254.0.0"), ipv4ToInt("169.254.255.255"))) return true;

  return false;
}

function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

const DISALLOWED_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "is.gd",
  "buff.ly",
  "cutt.ly",
  "rebrand.ly",
  "rb.gy",
  "shorturl.at"
]);

const DISALLOWED_EXT_RE = /\.(exe|msi|bat|cmd|scr|ps1|apk|jar|dmg|pkg|iso)(\?|#|$)/i;

function isHarmfulUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return true; }

  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  if (u.username || u.password) return true;

  const host = (u.hostname || "").toLowerCase();
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;

  if (isIPv4(host) && isPrivateIPv4(host)) return true;
  if (host.includes(":") && isPrivateIPv6(host)) return true;

  if (DISALLOWED_HOSTS.has(host)) return true;

  const port = u.port ? parseInt(u.port, 10) : 0;
  if (u.port && port !== 80 && port !== 443) return true;

  const path = (u.pathname || "") + (u.search || "") + (u.hash || "");
  if (DISALLOWED_EXT_RE.test(path)) return true;

  return false;
}

/* -------------------------------------------------------- */

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const [payloadB64, sig] = id.split(".");
  if (!payloadB64 || !sig) {
    return new Response("Invalid link", { status: 400 });
  }

  const secret = process.env.SIGNING_SECRET;
  if (!secret) {
    return new Response("Server misconfigured", { status: 500 });
  }

  // Accept both:
  // - v2 short tag (12 bytes => 16 chars b64url)
  // - legacy full tag (32 bytes => 43 chars b64url)
  const expectedShort = await hmacB64url(payloadB64, secret, 12);
  if (sig !== expectedShort) {
    const expectedFull = await hmacB64url(payloadB64, secret, null);
    if (sig !== expectedFull) return new Response("Invalid link", { status: 400 });
  }

  let payloadBytes;
  try {
    payloadBytes = b64urlToBytes(payloadB64);
  } catch {
    return new Response("Bad payload", {
      status: 400
    });
  }

  const p2 = parseV2Payload(payloadBytes);
  const p1 = p2 ? null : parseV1Payload(payloadBytes);
  const payload = p2 || p1;

  if (!payload?.u || !payload?.eMs) return new Response("Bad payload", { status: 400 });
  const dest = payload.u; // original destination or our file/text reference
  const origin = url.origin;

  // expired
  if (Date.now() > payload.eMs) {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link expired</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:40px;background:#0b0b0f;color:#e6e6f0}
    a{color:#7aa7ff}
    .ad{margin-top:28px;display:flex;justify-content:center}
  </style>
</head>
<body>
  <h1>Link expired</h1>
  <p>This link is no longer available.</p>

  <div class="ad" aria-label="Advertisement">
    <script>
      atOptions = {
        'key' : '50229c4eefa2707f1be8c13a32ca0a1c',
        'format' : 'iframe',
        'height' : 250,
        'width' : 300,
        'params' : {}
      };
    </script>
    <script src="https://www.highperformanceformat.com/50229c4eefa2707f1be8c13a32ca0a1c/invoke.js"></script>
  </div>
</body>
</html>`;
    return new Response(html, {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  // === R2 private file/text handling (no harmful check, no OG meta redirect to non-http) ===
if (typeof dest === "string" && dest.startsWith("file:")) {
  // format: file:files/<key>|<encName>|<encContentType>
  const rest = dest.slice("file:".length);
  const parts = rest.split("|");
  const key = parts[0]; // e.g. files/...
  const name = parts[1] ? decodeURIComponent(parts[1]) : "file.bin";
  const ct = parts[2] ? decodeURIComponent(parts[2]) : "";

  const to = new URL(
    `/api/r2-get?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}${ct ? `&ct=${encodeURIComponent(ct)}` : ""}`,
    origin
  );
  return Response.redirect(to.toString(), 302);
}

if (typeof dest === "string" && dest.startsWith("text:")) {
  // format: text:texts/<key>
  const key = dest.slice("text:".length);

  const to = new URL(
    `/api/r2-get?key=${encodeURIComponent(key)}&name=${encodeURIComponent("message.txt")}&ct=${encodeURIComponent("text/plain")}&inline=1`,
    origin
  );
  return Response.redirect(to.toString(), 302);
}
// === end R2 handling ===

  // Harmful re-check BEFORE any redirect
  if (isHarmfulUrl(dest)) {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Blocked</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:40px;background:#0b0b0f;color:#e6e6f0}
    a{color:#7aa7ff}
    .box{max-width:640px}
  </style>
</head>
<body>
  <div class="box">
    <h1>Blocked</h1>
    <p>${escapeHtml(HARMFUL_MSG)}</p>
    <p><a href="${escapeHtml(url.origin)}">Back to TempQR</a></p>
  </div>
</body>
</html>`;
    return new Response(html, {
      status: 451,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0"
      }
    });
  }

  const pageUrl = `${url.origin}/go/${encodeURIComponent(id)}`;
  const qrUrl = `${url.origin}/api/qr?id=${encodeURIComponent(id)}`;
  const title = "TempQR — Scan before it expires";
  const desc = "Scan the QR code or open the link before it expires.";

  // ALWAYS return HTML with OG tags.
  // Real users get redirected via meta refresh + JS.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>

  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:image" content="${escapeHtml(qrUrl)}">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${escapeHtml(qrUrl)}">
  <meta name="twitter:url" content="${escapeHtml(pageUrl)}">

  <meta http-equiv="refresh" content="0;url=${escapeHtml(dest)}">

  <script>
    // Fallback JS redirect for clients that ignore meta refresh
    try { window.location.replace(${JSON.stringify(dest)}); } catch (e) {}
  </script>

  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;background:#0b0b0f;color:#e6e6f0}
    a{color:#7aa7ff;word-break:break-all}
    .wrap{max-width:520px}
    .qr{margin-top:12px;border-radius:16px;background:#fff;display:inline-block;padding:10px}
  </style>
</head>
<body>
  <div class="wrap">
    <p><a href="${escapeHtml(dest)}">${escapeHtml(pageUrl)}</a></p>
    <div class="qr">
      <img src="${escapeHtml(qrUrl)}" alt="QR code" width="256" height="256">
    </div>
    <noscript>
      <p><a href="${escapeHtml(dest)}">Open destination</a></p>
    </noscript>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0"
    }
  });
}
