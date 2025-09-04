// api/checkout-session.js (ESM)
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    const { tier } = await readJson(req);
    const t = Number(tier);
    if (![1, 2, 3].includes(t)) return res.status(400).send("Bad tier");

    const sessionId = crypto.randomBytes(16).toString("hex"); // 32-hex

    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify({ session_id: sessionId, tier: t }));
  } catch (e) {
    console.error("[checkout-session] ERROR", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}
