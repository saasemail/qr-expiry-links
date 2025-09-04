// api/partner-webhook.js (ESM)
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const TIER_LIMITS = {
  1: { max_minutes: 60 * 24,     daily_limit: 5,    access_days: 7 },
  2: { max_minutes: 60 * 24 * 7, daily_limit: null, access_days: 30 },
  3: { max_minutes: 60 * 24 * 30, daily_limit: null, access_days: 36500 } // ~lifetime
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const PARTNER_WEBHOOK_SECRET = process.env.PARTNER_WEBHOOK_SECRET;

    if (!SUPABASE_URL || !SERVICE_ROLE || !PARTNER_WEBHOOK_SECRET) {
      return res.status(500).send("Server not configured");
    }

    const raw = await readRaw(req);
    const sig = req.headers["x-signature"] || "";
    if (!verifyHmac(raw, PARTNER_WEBHOOK_SECRET, sig)) {
      return res.status(401).send("Invalid signature");
    }

    const body = JSON.parse(raw);
    const { order_id, tier, email, session_id } = body || {};
    const meta = body?.metadata || {};
    const sessionId = String(session_id || meta.sessionId || "").trim() || null;

    if (!order_id || !tier || !TIER_LIMITS[tier]) {
      return res.status(400).send("Bad payload");
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { max_minutes, daily_limit, access_days } = TIER_LIMITS[tier];

    const expires_at =
      tier === 3
        ? new Date("9999-12-31T00:00:00.000Z").toISOString()
        : new Date(Date.now() + access_days * 24 * 60 * 60 * 1000).toISOString();

    const token = crypto.randomBytes(16).toString("hex");

    const { error } = await admin.from("tokens").insert([{
      token,
      plan: "pro",
      tier,
      max_minutes,
      daily_limit,
      expires_at,
      session_id: sessionId
    }]);
    if (error) throw error;

    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({
      ok: true,
      token,
      order_id,
      tier,
      session_id: sessionId,
      email: email || null
    }));
  } catch (e) {
    console.error("[partner-webhook] ERROR", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function verifyHmac(raw, secret, signature) {
  try {
    const h = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    return timingSafeEqual(h, String(signature));
  } catch {
    return false;
  }
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ...gore ostaje isto...

const body = JSON.parse(raw);
const t = Number(body?.tier);             // <— kast
const { order_id, email, session_id } = body || {};
const meta = body?.metadata || {};
const sessionId = String(session_id || meta.sessionId || "").trim() || null;

if (!order_id || !t || !TIER_LIMITS[t]) {
  return res.status(400).send("Bad payload");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
const { max_minutes, daily_limit, access_days } = TIER_LIMITS[t];

// ...expires_at ostaje isto...

const token = crypto.randomBytes(16).toString("hex");

// Idempotentno: ako stigne dupli webhook sa istim session_id, ne puca
const { error } = await admin
  .from("tokens")
  .upsert([{
    token,
    plan: "pro",
    tier: t,
    max_minutes,
    daily_limit,
    expires_at,
    session_id: sessionId
  }], { onConflict: "session_id", ignoreDuplicates: false });

if (error) throw error;

res.setHeader("Content-Type", "application/json");
return res.status(200).send(JSON.stringify({
  ok: true,
  token,
  order_id,
  tier: t,
  session_id: sessionId,
  email: email || null
}));
