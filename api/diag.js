// api/diag.js

export default async function handler(req, res) {
  try {
    let supaOk = false;
    try {
      await import("@supabase/supabase-js");
      supaOk = true;
    } catch {}

    res.setHeader("Content-Type", "application/json");
    res.status(200).send(
      JSON.stringify({
        ok: true,
        node: process.versions.node,
        supabaseInstalled: supaOk,
        envPresent: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY
      })
    );
  } catch (e) {
    res.status(500).send("diag-failed: " + (e?.message || e));
  }
}
