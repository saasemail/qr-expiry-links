export const config = { runtime: "edge" };

const HARMFUL_MSG = "Harmful URLs are not allowed.";

async function trackOpenedEvent(origin, payload) {
  try {
    await fetch(`${origin}/api/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

function isBot(req) {
  const ua = String(req.headers.get("user-agent") || "").toLowerCase();
  const bots = [
    "facebookexternalhit", "twitterbot", "whatsapp", "telegrambot", 
    "slackbot", "discordbot", "linkedinbot", "googlebot", "bingbot", 
    "pinterest", "skype", "embedly", "quora link preview", "outbrain", 
    "vkshare", "w3c_validator", "redditbot", "applebot", "yahoo! slurp",
    "viber", "line", "kakaotalk"
  ];
  return bots.some(bot => ua.includes(bot));
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "rb.gy", "shorturl.at"
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

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("id") || "";

    if (!token) {
      return new Response("Invalid link", { status: 400 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return new Response("Server misconfigured", { status: 500 });
    }

    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const { data: link, error } = await supabase
      .from("links")
      .select("url, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (error || !link) {
      return new Response("Invalid link", { status: 400 });
    }

    const dest = link.url;
    const origin = url.origin;

    // Expired check
    if (Date.now() > new Date(link.expires_at).getTime()){
      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>This TempQR link has expired</title>
  <meta name="robots" content="noindex,nofollow">
  <style>
    body { margin:0; min-height:100vh; font-family:system-ui,sans-serif; background:#080b12; color:#eef4ff; display:flex; align-items:center; justify-content:center; padding:28px 18px; }
    .card { max-width:600px; text-align:center; padding:40px; border:1px solid rgba(255,255,255,0.1); background:#111827; border-radius:24px; }
    h1 { font-size:40px; margin:0 0 16px; }
    p { color:#aab6cc; font-size:18px; line-height:1.6; }
    a { display:inline-block; margin-top:20px; padding:12px 24px; background:#6ee7f9; color:#000; text-decoration:none; border-radius:99px; font-weight:bold; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Expired</h1>
    <p>This TempQR link has expired and is no longer available.</p>
    <a href="${escapeHtml(origin)}">Create your own expiring link</a>
  </div>
</body>
</html>`;
      return new Response(html, { status: 410, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // R2 file/text redirects
    if (typeof dest === "string" && dest.startsWith("file:")) {
      const rest = dest.slice("file:".length);
      const parts = rest.split("|");
      const key = parts[0];
      let name = parts[1] ? decodeURIComponent(parts[1]) : String(key).split("/").pop() || "file";
      let ct = parts[2] ? decodeURIComponent(parts[2]) : "application/octet-stream";
      const to = new URL(`/api/r2-get?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}&ct=${encodeURIComponent(ct)}`, origin);
      return Response.redirect(to.toString(), 302);
    }

    if (typeof dest === "string" && dest.startsWith("text:")) {
      const key = dest.slice("text:".length);
      const to = new URL(`/api/r2-get?key=${encodeURIComponent(key)}&name=${encodeURIComponent("message.txt")}&ct=${encodeURIComponent("text/plain")}&inline=1`, origin);
      return Response.redirect(to.toString(), 302);
    }

    // Harmful URL check
    if (isHarmfulUrl(dest)) {
      const html = `<!doctype html><html><head><title>Blocked</title></head><body><h1>Blocked</h1><p>${escapeHtml(HARMFUL_MSG)}</p><a href="${escapeHtml(origin)}">Back</a></body></html>`;
      return new Response(html, { status: 451, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // Track opening
    if (!isBot(req)) {
      trackOpenedEvent(url.origin, {
        event_type: "link_opened",
        page: url.pathname || "/go",
        link_id: token,
        content_kind: "url",
        target_url: dest,
        referrer: url.searchParams.get("referer") || "",
        user_agent: req.headers.get("user-agent") || ""
      }).catch(() => {});
    }

    // UVEK vraćamo HTML sa OG tagovima (i za ljude i za botove).
    // Ljudi se preusmeravaju preko <script>, botovi čitaju sliku.
    const pageUrl = `${url.origin}/go/${encodeURIComponent(token)}`;
    const qrUrl = `${url.origin}/qr/${encodeURIComponent(token)}.png`;
    const title = "TempQR — Scan before it expires";
    const desc = "Scan the QR code or open the link before it expires.";

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
  <meta property="og:image:width" content="512">
  <meta property="og:image:height" content="512">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${escapeHtml(qrUrl)}">
  <meta name="twitter:url" content="${escapeHtml(pageUrl)}">
  <script>
    try { window.location.replace(${JSON.stringify(dest)}); } catch (e) {}
  </script>
</head>
<body style="background:#0b0e13; color:white; font-family:sans-serif; text-align:center; padding:50px;">
  <p>Redirecting you to the destination...</p>
  <p><a href="${escapeHtml(dest)}" style="color:#6ee7f9;">Click here if you are not redirected automatically.</a></p>
  <div class="qr" style="margin-top:20px;"><img src="${escapeHtml(qrUrl)}" alt="QR code" width="256" height="256"></div>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" }
    });
  } catch (e) {
    console.error("[go] ERROR:", e?.message || e);
    return new Response("Internal Server Error", { status: 500 });
  }
}