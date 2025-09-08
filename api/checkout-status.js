// api/checkout-status.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).send("Method Not Allowed");
    }

    const session_id = String(req.query?.session_id || "").trim();
    if (!session_id) return res.status(400).send("Missing session_id");

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).send("Server not configured");

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Token se upisuje isključivo preko partner-webhook-a
    const { data, error } = await admin
      .from("tokens")
      .select("token")
      .eq("session_id", session_id)
      .maybeSingle();

    if (error) {
      console.error("[checkout-status] select error:", error);
      return res.status(500).send("DB error");
    }

    res.setHeader("Content-Type", "application/json");
    if (data?.token) return res.status(200).json({ ready: true, token: data.token });

    return res.status(200).json({ ready: false });
  } catch (e) {
    console.error("[checkout-status] ERROR:", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}
