import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ isPro: false, error: "Email is required" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data, error } = await supabase
      .from("pro_users")
      .select("is_active, credits")
      .eq("email", email.toLowerCase().trim())
      .maybeSingle();

    if (error) {
      console.error("[check-pro] DB error:", error);
      return res.status(500).json({ isPro: false, error: "DB Error" });
    }

        // Korisnik je Pro ako ima aktivnu pretplatu ILI ima bar 1 kredit
    const isSub = data?.is_active === true;
    const isPro = isSub || (data?.credits || 0) > 0;
    
    return res.status(200).json({ 
      isPro, 
      isSub, // Šaljemo frontendu da zna da li je pretplatnik
      credits: data?.credits || 0,
      found: !!data
    });

  } catch (error) {
    console.error("[check-pro] Error:", error);
    return res.status(500).json({ isPro: false, error: "Internal Server Error" });
  }
}