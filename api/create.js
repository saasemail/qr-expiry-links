// api/create.js (ESM) — Pro requires login (JWT), Free works without login
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      console.error("[create] Missing env");
      return res.status(500).send("Server not configured (missing env)");
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await readJson(req);
    const url = (body?.url || "").trim();
    let minutes = parseInt(body?.minutes, 10);
    const token = (body?.token || "").trim();

    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Invalid URL");
    if (!Number.isFinite(minutes) || minutes < 1) minutes = 1;

    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const ua = (req.headers["user-agent"] || "").slice(0, 300);

    const FREE_MAX_MINUTES = 60;
    const FREE_DAILY_LIMIT = 1;
    const TIER1_MAX = 60 * 24;
    const TIER2_MAX = 60 * 24 * 7;
    const TIER3_MAX = 60 * 24 * 30;

    const proIntent = minutes > FREE_MAX_MINUTES || !!token;
    let userId = null;

    if (proIntent) {
      const auth = String(req.headers["authorization"] || "");
      const m = auth.match(/^Bearer\s+(.+)$/i);
      const accessToken = m?.[1];
      if (!accessToken) return res.status(401).send("Login required for Pro");
      const { data, error } = await admin.auth.getUser(accessToken);
      if (error || !data?.user) return res.status(401).send("Invalid session");
      userId = data.user.id;
    }

    let plan = "free";
    let tier = null;
    let maxMinutes = FREE_MAX_MINUTES;
    let dailyLimit = FREE_DAILY_LIMIT;

    if (token) {
      try {
        const { data: tok, error } = await admin
          .from("tokens")
          .select("plan, tier, max_minutes, daily_limit, expires_at")
          .eq("token", token)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();

        if (!error && tok?.plan === "pro") {
          plan = "pro";
          tier = tok?.tier ?? null;

          if (Number.isFinite(tok?.max_minutes)) {
            maxMinutes = tok.max_minutes;
          } else if (tier === 1) {
            maxMinutes = TIER1_MAX;
          } else if (tier === 2) {
            maxMinutes = TIER2_MAX;
          } else if (tier === 3) {
            maxMinutes = TIER3_MAX;
          } else {
            maxMinutes = TIER2_MAX;
          }

          if (tok?.daily_limit === null) {
            dailyLimit = null;
          } else if (Number.isFinite(tok?.daily_limit)) {
            dailyLimit = tok.daily_limit;
          } else if (tier === 1) {
            dailyLimit = 5;
          } else {
            dailyLimit = null;
          }
        }
      } catch (e) {
        console.warn("[create] token lookup skipped:", e?.message);
      }
    }

    if (dailyLimit !== null) {
      try {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);

        let query = admin
          .from("links")
          .select("*", { count: "exact", head: true })
          .gte("created_at", dayStart.toISOString());

        if (plan === "free") {
          query = query.eq("creator_ip", ip);
        } else if (userId) {
          // If you later add a creator_user_id column, filter here.
          // query = query.eq("creator_user_id", userId);
        }

        const { count, error: cntErr } = await query;
        if (!cntErr && (count ?? 0) >= dailyLimit) {
          return res.status(429).send(`Daily limit reached (${dailyLimit}/day).`);
        }
      } catch (e) {
        console.warn("[create] daily-limit check skipped:", e?.message);
      }
    }

    if (Number.isFinite(maxMinutes) && minutes > maxMinutes) minutes = maxMinutes;
    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

    let row = null;

    try {
      const payload = { url, expires_at: expiresAt, creator_ip: ip, plan: plan || "free", tier };
      const { data, error } = await admin
        .from("links")
        .insert([payload])
        .select("id, expires_at")
        .single();
      if (error) throw error;
      row = data;
    } catch (e) {
      console.error("[create] full insert error:", normalizeErr(e));
    }

    if (!row) {
      try {
        const { data, error } = await admin
          .from("links")
          .insert([{ url, expires_at: expiresAt, plan: plan || "free" }])
          .select("id, expires_at")
          .single();
        if (error) throw error;
        row = data;
      } catch (e2) {
        console.error("[create] minimal insert error:", normalizeErr(e2));
      }
    }

    if (!row) return res.status(500).send("Create failed");

    try {
      await admin.from("link_events").insert([{
        link_id: row.id,
        event: "create",
        ip,
        user_agent: ua,
        plan,
        tier
      }]);
    } catch (e) {
      console.warn("[create] event log failed:", normalizeErr(e));
    }

    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({
      id: row.id,
      expires_at: row.expires_at,
      plan,
      tier,
      minutes
    }));
  } catch (e) {
    console.error("[create] ERROR", normalizeErr(e));
    return res.status(500).send("Internal Server Error");
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function normalizeErr(e) {
  if (!e) return "unknown";
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}
