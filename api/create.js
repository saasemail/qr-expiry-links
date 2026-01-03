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

    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return res.status(400).send("Invalid JSON"); }

    const url = String(body?.url || "").trim();
    const minutes = Number(body?.minutes);
    const proToken = body?.token ? String(body.token).trim() : null;

    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Bad url");
    if (!Number.isFinite(minutes) || minutes < 1) return res.status(400).send("Bad minutes");

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
