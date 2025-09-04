// api/checkout-status.js (ESM)
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).send("Method Not Allowed");
    }

    const sessionId = String(req.query.session_id || "").trim();
    if (!sessionId) return res.status(400).send("Missing session_id");

    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await admin
      .from("tokens")
      .select("token, tier, expires_at")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (error) throw error;

    res.setHeader("Content-Type", "application/json");
    if (!data) return res.status(200).send(JSON.stringify({ ready: false }));

    return res.status(200).send(JSON.stringify({
      ready: true,
      token: data.token,
      tier: data.tier,
      expires_at: data.expires_at
    }));
  } catch (e) {
    console.error("[checkout-status] ERROR", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}
