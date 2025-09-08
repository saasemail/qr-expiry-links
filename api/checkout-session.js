// api/checkout-session.js
import { randomBytes } from "node:crypto";

const TIER_LIMITS = {
  1: { max_minutes: 60 * 24,      daily_limit: 5,    access_days: 7 },
  2: { max_minutes: 60 * 24 * 7,  daily_limit: null, access_days: 30 },
  3: { max_minutes: 60 * 24 * 30, daily_limit: null, access_days: 36500 }
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    const { tier } = req.body || {};
    const t = Number(tier);
    if (!t || !TIER_LIMITS[t]) return res.status(400).send("Bad tier");

    // Samo generišemo session_id — NIKAKAV token se ovde ne izdaje.
    const session_id = "SID-" + randomBytes(6).toString("hex").toUpperCase();

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ session_id });
  } catch (e) {
    console.error("[checkout-session] ERROR:", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}
