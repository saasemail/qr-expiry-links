// api/partner-webhook.js
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const TIER_LIMITS = {
  1: { max_minutes: 60 * 24,      daily_limit: 5,    access_days: 7 },
  2: { max_minutes: 60 * 24 * 7,  daily_limit: null, access_days: 30 },
  3: { max_minutes: 60 * 24 * 30, daily_limit: null, access_days: 36500 }
};

export default async function handler(req, res) {
  try {
    // GET /api/partner-webhook?diag=1 — brza dijagnostika
    if (req.method === "GET" && String(req.query?.diag || "") === "1") {
      return res.status(200).json({
        ok: true,
        step: "diag",
        runtime: "nodejs20.x",
        ts: new Date().toISOString(),
        env: {
          SUPABASE_URL: !!process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          PARTNER_WEBHOOK_SECRET: !!process.env.PARTNER_WEBHOOK_SECRET
        }
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      PARTNER_WEBHOOK_SECRET,
      DIAG
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PARTNER_WEBHOOK_SECRET) {
      if (DIAG) console.error("[partner-webhook] Missing env");
      return res.status(500).json({ ok: false, step: "read-env", msg: "Missing env vars" });
    }

    const raw = await readRaw(req);

    // HMAC verifikacija nad sirovim telom
    const sigHeader = String(req.headers["x-signature"] || "");
    const serverDigest = createHmac("sha256", PARTNER_WEBHOOK_SECRET)
      .update(raw, "utf8")
      .digest();

    let okSig = false;
    try {
      const client = Buffer.from(sigHeader, "hex");
      okSig = client.length === serverDigest.length && timingSafeEqual(client, serverDigest);
    } catch { okSig = false; }

    if (!okSig) {
      return res.status(401).json({ ok: false, step: "verify-hmac", msg: "Invalid signature" });
    }

    // JSON body
    let body;
    try { body = JSON.parse(raw); }
    catch { return res.status(400).json({ ok: false, step: "parse-json", msg: "Invalid JSON" }); }

    const order_id  = body?.order_id ? String(body.order_id) : null;
    const t         = Number(body?.tier);
    const sessionId = (body?.session_id || body?.metadata?.sessionId || "").toString() || null;

    if (!t || !TIER_LIMITS[t]) {
      return res.status(400).json({ ok: false, step: "validate", msg: "Bad or missing tier" });
    }

    const { max_minutes, daily_limit, access_days } = TIER_LIMITS[t];
    const expires_at =
      t === 3
        ? "9999-12-31T00:00:00.000Z"
        : new Date(Date.now() + access_days * 24 * 60 * 60 * 1000).toISOString();

    const token = randomBytes(16).toString("hex");

    // Upsert u Supabase REST-om — idempotentno po session_id (ignoriši duplikate)
    const upsertPayload = [{
      token,
      plan: "pro",
      tier: t,
      max_minutes,
      daily_limit,
      expires_at,
      session_id: sessionId,
      order_id
    }];

    const rest = await fetch(`${SUPABASE_URL}/rest/v1/tokens?on_conflict=session_id`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=ignore-duplicates" // <— važno
      },
      body: JSON.stringify(upsertPayload)
    });

    const restText = await rest.text();
    if (!rest.ok) {
      if (DIAG) console.error("[partner-webhook] rest-upsert", rest.status, restText);
      return res.status(500).json({
        ok: false,
        step: "rest-upsert",
        status: rest.status,
        msg: restText?.slice(0, 400) || "REST error"
      });
    }

    return res.status(200).json({
      ok: true,
      token,
      tier: t,
      session_id: sessionId,
      order_id
    });
  } catch (e) {
    console.error("[partner-webhook] FATAL", e?.message || e);
    return res.status(500).json({ ok: false, step: "fatal", msg: e?.message || String(e) });
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
