// api/create.js
import { createClient } from "@supabase/supabase-js";

// ENV varijable (setuješ u Vercel → Settings → Environment Variables)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Limiti
const FREE_DAILY_LIMIT = 5;              // linkova po IP / dan
const FREE_MAX_MINUTES = 15;             // max trajanje u minutima
const PRO_DEFAULT_MAX_MINUTES = 60 * 24 * 7; // 7 dana

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const body = await readJson(req); // { url, minutes, token }
    const url = (body?.url || "").trim();
    let minutes = parseInt(body?.minutes, 10);
    const token = (body?.token || "").trim();

    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Invalid URL");
    if (!Number.isFinite(minutes) || minutes < 1) minutes = 1;

    // IP
    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    // Provera PRO tokena (tabela public.tokens: token, plan, max_minutes, expires_at)
    let plan = "free";
    let maxMinutes = FREE_MAX_MINUTES;

    if (token) {
      const { data: tok } = await admin
        .from("tokens")
        .select("plan, max_minutes, expires_at")
        .eq("token", token)
        .gt("expires_at", new Date().toISOString())
        .single()
        .throwOnError(false);

      if (tok?.plan === "pro") {
        plan = "pro";
        maxMinutes = tok?.max_minutes || PRO_DEFAULT_MAX_MINUTES;
      }
    }

    // Rate limit (free samo): koliko linkova je IP napravio danas
    if (plan === "free") {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const { count, error: cntErr } = await admin
        .from("links")
        .select("*", { count: "exact", head: true })
        .eq("creator_ip", ip)
        .gte("created_at", dayStart.toISOString());

      if (cntErr) {
        console.error("[create] count error", cntErr);
        return res.status(500).send("Counter failed");
      }
      if ((count ?? 0) >= FREE_DAILY_LIMIT) {
        return res
          .status(429)
          .send(`Free daily limit reached (${FREE_DAILY_LIMIT}/day).`);
      }
    }

    // Clamp trajanje
    if (minutes > maxMinutes) minutes = maxMinutes;

    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

    // Upis linka (service role: ne izlažemo ključeve na klijentu)
    const { data, error } = await admin
      .from("links")
      .insert([{ url, expires_at: expiresAt, creator_ip: ip, plan }], {
        returning: "representation",
      })
      .select("id, expires_at")
      .single();

    if (error || !data) {
      console.error("[create] insert error", error);
      return res.status(500).send("Create failed");
    }

    res.setHeader("Content-Type", "application/json");
    res.status(200).send(
      JSON.stringify({
        id: data.id,
        expires_at: data.expires_at,
        plan,
        minutes,
      })
    );
  } catch (e) {
    console.error("[create] ERROR", e);
    res.status(500).send("Internal Server Error");
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
