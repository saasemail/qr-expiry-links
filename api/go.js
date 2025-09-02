// api/go.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return new Response("Missing link ID", { status: 400 });
    }

    const { data, error } = await supabase
      .from("links")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return new Response("Link not found", { status: 404 });
    }

    const now = new Date();
    const expiresAt = new Date(data.expires_at);

    if (now > expiresAt) {
      return new Response("This link has expired", { status: 410 });
    }

    return Response.redirect(data.url, 302);
  } catch (err) {
    console.error("API Error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
