import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false, // Potrebno da bismo dobili raw body za verifikaciju
  },
};

// Pomoćna funkcija za čitanje raw body-ja
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers["x-signature"];
    const secret = process.env.FREEMIUS_SECRET_KEY;

       // 1. Verifikacija potpisa (Fail-Closed - ako nema secret/signature, odbij)
    if (!secret || !signature) {
      console.error("[webhook] Missing secret or signature");
      return res.status(401).send("Unauthorized");
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("[webhook] Invalid signature");
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(rawBody);
    console.log("[webhook] Received event:", payload.type || "unknown");

    if (payload.type === "license.created") {
      // Izvlačimo podatke iz payload-a
      const userEmail = payload.objects?.user?.email || payload.user?.email;
      const licenseId = payload.objects?.license?.id || payload.license?.id;
      const planId = payload.objects?.plan?.id || payload.plan?.id;

      if (!userEmail) {
        console.error("[webhook] No email found in payload");
        return res.status(400).send("No email found");
      }

      // 3. Upisujemo u Supabase
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );

            // Prvo proverimo da li korisnik već postoji (da znamo koliko kredita ima)
      const { data: existingUser } = await supabase
        .from("pro_users")
        .select("credits")
        .eq("email", userEmail)
        .maybeSingle();

      const currentCredits = existingUser?.credits || 0;
      
      // DODATO: Ako je Freemius poslao isti license_id (retry), ignorisemo ga
      const currentLicenseId = existingUser?.license_id?.toString() || null;
      if (currentLicenseId && licenseId && currentLicenseId === licenseId.toString()) {
        console.log(`[webhook] License ${licenseId} already processed. Ignoring.`);
        return res.status(200).json({ received: true, note: "Already processed" });
      }

      const { error } = await supabase.from("pro_users").upsert(
        {
          email: userEmail,
          license_id: licenseId?.toString() || null,
          plan_id: planId?.toString() || null,
          is_active: true,
          credits: currentCredits + 1, // Dodajemo 1 kredit
        },
        { onConflict: "email" }
      );

      if (error) {
        console.error("[webhook] Supabase error:", error);
        return res.status(500).send("DB Error");
      }

      console.log(`[webhook] Successfully unlocked Pro for: ${userEmail}`);
    }

    // Uvek vrati 200 Freemiusu da zna da smo primili
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("[webhook] Error:", error);
    return res.status(500).send("Internal Server Error");
  }
}