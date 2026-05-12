// api/go.js — ALWAYS return HTML (with OG tags) so chat preview uses our QR image.
// Then redirect real users via meta refresh + JS (bots won't execute JS).

export const config = { runtime: "edge" };

const HARMFUL_MSG = "Harmful URLs are not allowed.";

async function trackOpenedEvent(origin, payload) {
  try {
    await fetch(`${origin}/api/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_) {
    // analytics must never break redirect flow
  }
}

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
  <title>This TempQR link has expired</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    :root{
      --bg:#080b12;
      --card:#111827;
      --card2:#0f172a;
      --text:#eef4ff;
      --muted:#aab6cc;
      --soft:#7aa7ff;
      --line:rgba(255,255,255,.10);
      --glow:rgba(122,167,255,.26);
    }

    *{box-sizing:border-box}

    body{
      margin:0;
      min-height:100vh;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      background:
        radial-gradient(circle at 18% 12%, rgba(79,70,229,.22), transparent 32%),
        radial-gradient(circle at 84% 14%, rgba(14,165,233,.16), transparent 30%),
        linear-gradient(180deg,#080b12 0%,#0b1020 100%);
      color:var(--text);
      display:flex;
      align-items:center;
      justify-content:center;
      padding:28px 18px;
    }

        .expired-brand-badge{
      position:fixed;
      top:10px;
      left:12px;
      z-index:10;
      display:inline-flex;
      align-items:center;
      gap:10px;
      text-decoration:none;
      color:rgba(255,255,255,.95);
    }

    .expired-brand-icon img{
      width:44px;
      height:44px;
      display:block;
      border-radius:8px;
    }

    .expired-brand-name{
      font-size:18px;
      font-weight:700;
      line-height:1;
      margin:0;
      color:rgba(255,255,255,.95);
    }

    @media (min-width:561px){
      .expired-brand-name{
        font-size:20px;
      }

      .expired-brand-icon img{
        width:50px;
        height:50px;
      }
    }

    @media (max-width:560px){
      .expired-brand-badge{
        top:8px;
        left:10px;
      }

      .expired-brand-icon img{
        width:40px;
        height:40px;
      }
    }

    .wrap{
      width:100%;
      max-width:720px;
      text-align:center;
    }

    .card{
      position:relative;
      overflow:hidden;
      border:1px solid var(--line);
      background:
        linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.025)),
        linear-gradient(135deg,var(--card),var(--card2));
      border-radius:28px;
      padding:42px 30px;
      box-shadow:
        0 24px 80px rgba(0,0,0,.38),
        0 0 0 1px rgba(255,255,255,.03) inset;
    }

    .card:before{
      content:"";
      position:absolute;
      inset:-1px;
      background:
        radial-gradient(circle at 50% 0%, rgba(122,167,255,.22), transparent 42%);
      pointer-events:none;
    }

    .content{
      position:relative;
      z-index:1;
    }

    .status{
      width:74px;
      height:74px;
      border-radius:24px;
      margin:0 auto 22px;
      display:grid;
      place-items:center;
      background:rgba(248,113,113,.10);
      border:1px solid rgba(248,113,113,.22);
      color:#fecaca;
      box-shadow:0 18px 48px rgba(248,113,113,.08);
      font-size:34px;
      line-height:1;
    }

    h1{
      margin:0 0 12px;
      font-size:clamp(34px,7vw,58px);
      line-height:.98;
      letter-spacing:-.06em;
      font-weight:900;
    }

    .lead{
      margin:0 auto;
      max-width:560px;
      color:var(--muted);
      font-size:clamp(17px,3.5vw,20px);
      line-height:1.62;
    }

    .note{
      margin:24px auto 0;
      max-width:540px;
      padding:16px 18px;
      border-radius:18px;
      border:1px solid rgba(122,167,255,.16);
      background:rgba(122,167,255,.07);
      color:#d9e6ff;
      font-size:15px;
      line-height:1.55;
    }

    .actions{
      display:flex;
      justify-content:center;
      flex-wrap:wrap;
      gap:12px;
      margin-top:30px;
    }

    .btn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:48px;
      padding:0 18px;
      border-radius:999px;
      text-decoration:none;
      font-weight:800;
      letter-spacing:-.01em;
      transition:transform .15s ease, border-color .15s ease, background .15s ease;
    }

    .btn-primary{
      color:#07111f;
      background:linear-gradient(135deg,#93c5fd,#c4b5fd);
      box-shadow:0 16px 45px var(--glow);
    }

    .btn-secondary{
      color:var(--text);
      border:1px solid var(--line);
      background:rgba(255,255,255,.05);
    }

    .btn:hover{
      transform:translateY(-1px);
    }

    .foot{
      margin-top:18px;
      color:rgba(238,244,255,.52);
      font-size:13px;
      line-height:1.5;
    }

    @media (max-width:520px){
      body{padding:22px 14px}
      .card{border-radius:24px;padding:34px 22px}
      .status{width:64px;height:64px;border-radius:20px;font-size:30px}
      .actions{display:grid;grid-template-columns:1fr}
      .btn{width:100%}
    }
  </style>
</head>
<body>
  <a class="expired-brand-badge" href="${escapeHtml(origin)}" aria-label="TempQR home">
    <span class="expired-brand-icon" aria-hidden="true">
      <img src="${escapeHtml(origin)}/TempQRlogo.svg" alt="" width="44" height="44">
    </span>
    <span class="expired-brand-name">TempQR</span>
  </a>

  <main class="wrap">
    <section class="card">
      <div class="content">
        <div class="status" aria-hidden="true">!</div>

        <h1>Expired</h1>

        <p class="lead">
          This TempQR link has expired and is no longer available.
        </p>

        <div class="note">
          The owner set this link to stop working after a limited time.
          This helps prevent old links from staying accessible forever.
        </div>

        <div class="actions">
          <a class="btn btn-primary" href="${escapeHtml(origin)}">Create your own expiring link</a>
          <a class="btn btn-secondary" href="${escapeHtml(origin)}/use-cases.html">See common use cases</a>
        </div>

        <p class="foot">
          TempQR creates temporary links and QR codes that stop working after the time you choose.
        </p>
      </div>
    </section>
  </main>
</body>
</html>`;
    return new Response(html, {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  // === R2 private file/text handling (no harmful check, no OG meta redirect to non-http) ===
  if (typeof dest === "string" && dest.startsWith("file:")) {
    // supports BOTH:
    // - short: file:files/<key>
    // - legacy: file:files/<key>|<encName>|<encContentType>
    const rest = dest.slice("file:".length);
    const parts = rest.split("|");

    const key = parts[0]; // e.g. files/abc123.jpg
    let name = parts[1] ? decodeURIComponent(parts[1]) : "";
    let ct = parts[2] ? decodeURIComponent(parts[2]) : "";

    // If short format (no name/ct), derive from key
    if (!name) {
      const base = String(key).split("/").pop() || "file";
      name = base; // e.g. "abc123.jpg"
    }
    if (!ct) {
      const ext = (name.split(".").pop() || "").toLowerCase();
      const mime =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        ext === "png" ? "image/png" :
        ext === "gif" ? "image/gif" :
        ext === "webp" ? "image/webp" :
        ext === "svg" ? "image/svg+xml" :
        ext === "pdf" ? "application/pdf" :
        ext === "txt" ? "text/plain" :
        ext === "mp4" ? "video/mp4" :
        ext === "mov" ? "video/quicktime" :
        ext === "mp3" ? "audio/mpeg" :
        ext === "wav" ? "audio/wav" :
        "application/octet-stream";
      ct = mime;
    }

    const to = new URL(
      `/api/r2-get?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}&ct=${encodeURIComponent(ct)}`,
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

  await trackOpenedEvent(url.origin, {
    event_type: "link_opened",
    page: url.pathname || "/go",
    link_id: id,
    content_kind: "url",
    referrer: req.headers.get("referer") || "",
    user_agent: req.headers.get("user-agent") || ""
  });

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
