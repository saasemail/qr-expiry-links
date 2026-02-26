// api/create.js — free, pro token ili pro preko user_id (JWT)

import { createHmac } from "node:crypto";

// Robustan reader: koristi req.body ako ga Vercel već parsira; u suprotnom čita raw stream.
async function readJSONBody(req) {
  if (req.body != null) {
    // Može biti string ili već objekat
    if (typeof req.body === "string" && req.body.length) {
      try { return JSON.parse(req.body); } catch { throw new Error("Invalid JSON"); }
    }
    if (typeof req.body === "object") return req.body;
  }
  // Fallback: raw stream
  const raw = await new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Invalid JSON"); }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sign(payload, secret) {
  const h = createHmac("sha256", secret).update(payload, "utf8").digest();
  return b64url(h);
}

// Short signature (truncated HMAC) to keep IDs compact.
// 12 bytes = 96-bit tag -> 16 chars base64url.
function signShort(payload, secret, bytes = 12) {
  const full = createHmac("sha256", secret).update(payload, "utf8").digest();
  return b64url(full.subarray(0, bytes));
}

// v2 payload (compact, binary):
// [1 byte version=2][4 bytes expirySeconds BE][utf8 url bytes]
function makeV2PayloadB64(url, expirySeconds) {
  const urlBytes = Buffer.from(String(url || ""), "utf8");
  const buf = Buffer.alloc(1 + 4 + urlBytes.length);
  buf[0] = 2;
  buf.writeUInt32BE(expirySeconds >>> 0, 1);
  urlBytes.copy(buf, 5);
  return b64url(buf);
}

function normalizeHttpUrl(input) {
  let s = String(input || "").trim();
  if (!s) return "";

  if (/\s/.test(s)) return "";

  if (s.startsWith("//")) s = "https:" + s;

  // If no scheme, default to https://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    s = "https://" + s;
  }

  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    return u.toString();
  } catch {
    return "";
  }
}

/* ---------------- Anti-abuse (no captcha) ---------------- */

const HARMFUL_MSG = "Harmful URLs are not allowed.";

// Lightweight in-memory rate limit (best-effort on serverless; per-instance).
const RL = {
  perMinute: 10,
  perDay: 150,
  minuteMs: 60_000,
  dayMs: 24 * 60 * 60_000,
  maxEntries: 25_000
};

const buckets = new Map();

function getClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "");
  if (xf) return xf.split(",")[0].trim() || "unknown";
  const xr = String(req.headers["x-real-ip"] || "");
  if (xr) return xr.trim();
  return String(req.socket?.remoteAddress || "unknown");
}

function pruneBucketsIfNeeded() {
  if (buckets.size <= RL.maxEntries) return;
  // Simple prune: delete oldest-ish entries by iterating (insertion order).
  const target = Math.floor(RL.maxEntries * 0.9);
  for (const k of buckets.keys()) {
    buckets.delete(k);
    if (buckets.size <= target) break;
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = {
      mCount: 0,
      mReset: now + RL.minuteMs,
      dCount: 0,
      dReset: now + RL.dayMs
    };
    buckets.set(ip, b);
    pruneBucketsIfNeeded();
  }

  if (now >= b.mReset) {
    b.mCount = 0;
    b.mReset = now + RL.minuteMs;
  }
  if (now >= b.dReset) {
    b.dCount = 0;
    b.dReset = now + RL.dayMs;
  }

  b.mCount += 1;
  b.dCount += 1;

  if (b.mCount > RL.perMinute) {
    return { ok: false, retryAfterSec: Math.ceil((b.mReset - now) / 1000) };
  }
  if (b.dCount > RL.perDay) {
    return { ok: false, retryAfterSec: Math.ceil((b.dReset - now) / 1000) };
  }
  return { ok: true, retryAfterSec: 0 };
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

  // 10.0.0.0/8
  if (inRange(n, ipv4ToInt("10.0.0.0"), ipv4ToInt("10.255.255.255"))) return true;
  // 127.0.0.0/8
  if (inRange(n, ipv4ToInt("127.0.0.0"), ipv4ToInt("127.255.255.255"))) return true;
  // 172.16.0.0/12
  if (inRange(n, ipv4ToInt("172.16.0.0"), ipv4ToInt("172.31.255.255"))) return true;
  // 192.168.0.0/16
  if (inRange(n, ipv4ToInt("192.168.0.0"), ipv4ToInt("192.168.255.255"))) return true;
  // 169.254.0.0/16 (link-local)
  if (inRange(n, ipv4ToInt("169.254.0.0"), ipv4ToInt("169.254.255.255"))) return true;

  return false;
}

function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local (fc00::/7)
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

  // block user:pass@host
  if (u.username || u.password) return true;

  const host = (u.hostname || "").toLowerCase();

  // localhost / internal-ish
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;

  // direct IP checks (no DNS resolve here)
  if (isIPv4(host) && isPrivateIPv4(host)) return true;
  if (host.includes(":") && isPrivateIPv6(host)) return true;

  // disallow common shorteners
  if (DISALLOWED_HOSTS.has(host)) return true;

  // disallow odd ports (allow empty, 80, 443)
  const port = u.port ? parseInt(u.port, 10) : 0;
  if (u.port && port !== 80 && port !== 443) return true;

  // disallow obvious executable downloads
  const path = (u.pathname || "") + (u.search || "") + (u.hash || "");
  if (DISALLOWED_EXT_RE.test(path)) return true;

  return false;
}

/* ---------------------------------------------------------- */

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (req.method === "GET" && (req.query?.diag === "1" || String(req.url).includes("diag=1"))) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json({ ok: true, from: "create", ts: new Date().toISOString() });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    // Rate limit early (counts all attempts)
    const ip = getClientIp(req);
    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec || 30));
      return res.status(429).send("Too many requests. Please try again later.");
    }

    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return res.status(400).send("Invalid JSON"); }

    const kind = String(body?.kind || "url").trim().toLowerCase(); // "url" | "file" | "text"
const rawUrl = String(body?.url || "").trim();
const minutes = Number(body?.minutes);
const proToken = body?.token ? String(body.token).trim() : null;

const isFile = kind === "file" || rawUrl.startsWith("file:");
const isText = kind === "text" || rawUrl.startsWith("text:");

let url = "";

// 1) FILE/TEXT: ne normalizujemo http(s) URL, već proverimo "reference" format
if (isFile) {
  // expected: file:files/<key>  (short reference)
  if (!rawUrl.startsWith("file:files/")) return res.status(400).send("Bad file reference");
  url = rawUrl;
} else if (isText) {
  // očekujemo: text:texts/<key>
  if (!rawUrl.startsWith("text:texts/")) return res.status(400).send("Bad text reference");
  url = rawUrl;
} else {
  // 2) URL: postojeći behavior
  url = normalizeHttpUrl(rawUrl);
  if (!url) return res.status(400).send("Bad url");

  // Harmful filter (no captcha) – samo za URL
  if (isHarmfulUrl(url)) {
    return res.status(403).send(HARMFUL_MSG);
  }
}

if (!Number.isFinite(minutes) || minutes < 1) return res.status(400).send("Bad minutes");

// FILE/TEXT mora biti plaćeno (za sada token ili Bearer JWT)
const devBypass = String(process.env.UPLOAD_DEV_BYPASS || "").trim() === "1";

if ((isFile || isText) && !devBypass) {
  const hasToken = !!proToken;
  const hasBearer = !!String(req.headers["authorization"] || "").match(/^Bearer\s+/i);

  if (!hasToken && !hasBearer) {
    return res.status(402).send("Payment required");
  }
}

    const SIGNING_SECRET = process.env.SIGNING_SECRET || "dev-secret";

    // 10 godina max (u minutima): 10 * 365 * 24 * 60 = 5,256,000
    const MAX_MINUTES_10Y = 5256000;

    // default: free
    let plan = "free";
    let tier = null;
    let max_minutes = MAX_MINUTES_10Y;

    // 1) Ako postoji eksplicitni token u body-ju -> koristi njega
    let usedByUserId = null;
    if (proToken) {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).send("Server not configured");

      const { createClient } = await import("@supabase/supabase-js");
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

      const { data: tok, error } = await admin
        .from("tokens")
        .select("token,tier,max_minutes,expires_at,user_id")
        .eq("token", proToken)
        .maybeSingle();
      if (error) { console.error("[create] token select error:", error); return res.status(500).send("DB error"); }
      if (!tok) return res.status(401).send("Invalid token");
      if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) return res.status(401).send("Token expired");

      plan = "pro";
      tier = tok.tier || null;
      max_minutes = Number(tok.max_minutes || MAX_MINUTES_10Y);
      usedByUserId = tok.user_id || null;
    }

    // 2) Ako NEMA tokena, ali postoji Authorization: Bearer <JWT> -> pročitaj Pro iz naloga
    if (!proToken) {
      const auth = String(req.headers["authorization"] || "");
      const m = auth.match(/^Bearer\s+(.+)$/i);
      const jwt = m?.[1] || null;

      if (jwt) {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE) return res.status(500).send("Server not configured");

        const { createClient } = await import("@supabase/supabase-js");

        // 2a) validacija JWT-a (GoTrue)
        const pub = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
        const { data: userData, error: userErr } = await pub.auth.getUser(jwt);
        if (userErr) { console.error("[create] auth.getUser error:", userErr); }
        const userId = userData?.user?.id || null;

        if (userId) {
          // 2b) pronađi najjači aktivni token za user_id
          const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
          const { data: rows, error } = await admin
            .from("tokens")
            .select("tier,max_minutes,expires_at")
            .eq("user_id", userId)
            .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
            .order("max_minutes", { ascending: false })
            .limit(1);
          if (error) { console.error("[create] user tokens select error:", error); }
          const best = rows?.[0];
          if (best) {
            plan = "pro";
            tier = best.tier || null;
            max_minutes = Number(best.max_minutes || MAX_MINUTES_10Y);
          }
        }
      }
    }

    // primeni limit (globalno hard-cap na 10 godina)
    const allowed = Math.min(minutes, max_minutes, MAX_MINUTES_10Y);

    // Compact v2 ID:
    // payload = base64url([v=2][expirySeconds][url])
    // sig = base64url(HMAC(payload)) truncated to 12 bytes
    const expirySeconds = Math.floor(Date.now() / 1000) + Math.floor(allowed * 60);
    const payloadB64 = makeV2PayloadB64(url, expirySeconds);
    const sig = signShort(payloadB64, SIGNING_SECRET, 12);
    const id = `${payloadB64}.${sig}`;

    const expiresAt = new Date(expirySeconds * 1000).toISOString();

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ id, expires_at: expiresAt, plan, tier, minutes: allowed });
  } catch (e) {
    console.error("[create] ERROR:", e?.message || e);
    return res.status(500).send("Internal Server Error");
  } finally {
    const ms = Date.now() - t0;
    if (ms > 9000) console.warn("[create] slow:", ms, "ms");
  }
}
