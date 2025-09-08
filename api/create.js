// api/create.js — free, pro token ili pro preko user_id (JWT)

import { createHmac } from "node:crypto";

// Robustan reader: koristi req.body ako ga Vercel već parsira; u suprotnom čita raw stream.
async function readJSONBody(req) {
  if (req.body != null) {
    // Može biti string ili već objekat
    if (typeof req.body === "string" && req.body.length) {
      try { return JSON.parse(req.body); } catch { throw new Error("Invalid JSON"); }
    }
    if (typeof req.body === "object") return req.body;
  }
  // Fallback: raw stream
  const raw = await new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Invalid JSON"); }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function sign(payload, secret) {
  const h = createHmac("sha256", secret).update(payload, "utf8").digest();
  return b64url(h);
}

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    if (req.method === "GET" && (req.query?.diag === "1" || String(req.url).includes("diag=1"))) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json({ ok: true, from: "create", ts: new Date().toISOString() });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }

    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return res.status(400).send("Invalid JSON"); }

    const url = String(body?.url || "").trim();
    const minutes = Number(body?.minutes);
    const proToken = body?.token ? String(body.token).trim() : null;

    if (!/^https?:\/\//i.test(url)) return res.status(400).send("Bad url");
    if (!Number.isFinite(minutes) || minutes < 1) return res.status(400).send("Bad minutes");

    const SIGNING_SECRET = process.env.SIGNING_SECRET || "dev-secret";

    // default: free
    let plan = "free";
    let tier = null;
    let max_minutes = 60;

    // 1) Ako postoji eksplicitni token u body-ju -> koristi njega
    let usedByUserId = null;
    if (proToken) {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SERVICE_ROLE) return res.status(500).send("Server not configured");

      const { createClient } = await import("@supabase/supabase-js");
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

      const { data: tok, error } = await admin
        .from("tokens")
        .select("token,tier,max_minutes,expires_at,user_id")
        .eq("token", proToken)
        .maybeSingle();
      if (error) { console.error("[create] token select error:", error); return res.status(500).send("DB error"); }
      if (!tok) return res.status(401).send("Invalid token");
      if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) return res.status(401).send("Token expired");

      plan = "pro";
      tier = tok.tier || null;
      max_minutes = Number(tok.max_minutes || 60);
      usedByUserId = tok.user_id || null;
    }

    // 2) Ako NEMA tokena, ali postoji Authorization: Bearer <JWT> -> pročitaj Pro iz naloga
    if (!proToken) {
      const auth = String(req.headers["authorization"] || "");
      const m = auth.match(/^Bearer\s+(.+)$/i);
      const jwt = m?.[1] || null;

      if (jwt) {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE) return res.status(500).send("Server not configured");

        const { createClient } = await import("@supabase/supabase-js");

        // 2a) validacija JWT-a (GoTrue)
        const pub = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
        const { data: userData, error: userErr } = await pub.auth.getUser(jwt);
        if (userErr) { console.error("[create] auth.getUser error:", userErr); }
        const userId = userData?.user?.id || null;

        if (userId) {
          // 2b) pronađi najjači aktivni token za user_id
          const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
          const { data: rows, error } = await admin
            .from("tokens")
            .select("tier,max_minutes,expires_at")
            .eq("user_id", userId)
            .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
            .order("max_minutes", { ascending: false })
            .limit(1);
          if (error) { console.error("[create] user tokens select error:", error); }
          const best = rows?.[0];
          if (best) {
            plan = "pro";
            tier = best.tier || null;
            max_minutes = Number(best.max_minutes || 60);
          }
        }
      }
    }

    // primeni limit
    const allowed = Math.min(minutes, max_minutes);
    const expiresAt = new Date(Date.now() + allowed * 60_000).toISOString();
    const payload = b64url(JSON.stringify({ u: url, e: expiresAt, v: 1 }));
    const sig = sign(payload, SIGNING_SECRET);
    const id = `${payload}.${sig}`;

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ id, expires_at: expiresAt, plan, tier, minutes: allowed });
  } catch (e) {
    console.error("[create] ERROR:", e?.message || e);
    return res.status(500).send("Internal Server Error");
  } finally {
    const ms = Date.now() - t0;
    if (ms > 9000) console.warn("[create] slow:", ms, "ms");
  }
}
