// api/create.js (ESM)
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

    // Package policy defaults (FREE)
    const FREE_MAX_MINUTES = 60;          // 1h
    const FREE_DAILY_LIMIT = 1;           // 1 link/day
    const TIER1_MAX = 60 * 24;            // 24h
    const TIER2_MAX = 60 * 24 * 7;        // 7 days
    const TIER3_MAX = 60 * 24 * 30;       // 30 days (lifetime per-link cap)

    let plan = "free";
    let tier = null;
    let maxMinutes = FREE_MAX_MINUTES;
    let dailyLimit = FREE_DAILY_LIMIT;

    if (token) {
      try {
        const { data: tok } = await admin
          .from("tokens")
          .select("plan, tier, max_minutes, daily_limit, expires_at")
          .eq("token", token)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();

        if (tok?.plan === "pro") {
          plan = "pro";
          tier = tok?.tier ?? null;

          // Determine max per-link duration
          if (Number.isFinite(tok?.max_minutes)) {
            maxMinutes = tok.max_minutes;
          } else if (tier === 1) {
            maxMinutes = TIER1_MAX;
          } else if (tier === 2) {
            maxMinutes = TIER2_MAX;
          } else if (tier === 3) {
            maxMinutes = TIER3_MAX;
          } else {
            maxMinutes = TIER2_MAX; // default Pro if tier missing
          }

          // Determine daily limit
          if (tok?.daily_limit === null) {
            dailyLimit = null;
          } else if (Number.isFinite(tok?.daily_limit)) {
            dailyLimit = tok.daily_limit;
          } else if (tier === 1) {
            dailyLimit = 5;
          } else {
            dailyLimit = null; // unlimited for tier2/tier3
          }
        }
      } catch (e) {
        console.warn("[create] token lookup skipped:", e?.message);
      }
    }

    // Enforce daily limit if applicable
    if (dailyLimit !== null) {
      try {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);

        const { count } = await admin
          .from("links")
          .select("*", { count: "exact", head: true })
          .eq("creator_ip", ip)
          .gte("created_at", dayStart.toISOString());

        if ((count ?? 0) >= dailyLimit) {
          return res
            .status(429)
            .send(`Daily limit reached (${dailyLimit}/day).`);
        }
      } catch (e) {
        console.warn("[create] daily limit check skipped:", e?.message);
      }
    }

    // Clamp requested minutes to per-plan maximum
    if (Number.isFinite(maxMinutes) && minutes > maxMinutes) {
      minutes = maxMinutes;
    }
    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

    // Insert with extended fields; fallback to minimal if schema lacks columns
    let row = null;
    try {
      const { data } = await admin
        .from("links")
        .insert([{ url, expires_at: expiresAt, creator_ip: ip, plan, tier }])
        .select("id, expires_at")
        .single();
      row = data;
    } catch {
      const { data } = await admin
        .from("links")
        .insert([{ url, expires_at: expiresAt }])
        .select("id, expires_at")
        .single();
      row = data;
    }

    if (!row) {
      console.error("[create] insert failed");
      return res.status(500).send("Create failed");
    }

    res.setHeader("Content-Type", "application/json");
    return res
      .status(200)
      .send(JSON.stringify({ id: row.id, expires_at: row.expires_at, plan, tier, minutes }));
  } catch (e) {
    console.error("[create] ERROR", e);
    return res.status(500).send("Internal Server Error");
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
