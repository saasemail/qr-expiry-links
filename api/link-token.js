// api/link-token.js — veži dobijeni Pro token za ulogovanog korisnika
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    const auth = String(req.headers["authorization"] || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const jwt = m?.[1] || null;
    if (!jwt) return res.status(401).send("Unauthorized");

    const { token } = req.body || {};
    const t = String(token || "").trim();
    if (!t) return res.status(400).send("Missing token");

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !ANON || !SERVICE_ROLE) return res.status(500).send("Server not configured");

    const pub = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
    const { data: userData, error: userErr } = await pub.auth.getUser(jwt);
    if (userErr || !userData?.user) return res.status(401).send("Unauthorized");
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // Provera tokena
    const { data: tok, error: selErr } = await admin
      .from("tokens")
      .select("token,user_id,expires_at")
      .eq("token", t)
      .maybeSingle();
    if (selErr) return res.status(500).send("DB error");
    if (!tok) return res.status(400).send("Invalid token");
    if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) return res.status(400).send("Token expired");
    if (tok.user_id && tok.user_id !== userId) return res.status(409).send("Token already linked to another account");

    const { error: updErr } = await admin
      .from("tokens")
      .update({ user_id: userId })
      .eq("token", t);
    if (updErr) return res.status(500).send("DB error");

    return res.status(200).json({ ok: true, linked: true });
  } catch (e) {
    console.error("[link-token] ERROR:", e?.message || e);
    res.status(500).send("Internal Server Error");
  }
}
