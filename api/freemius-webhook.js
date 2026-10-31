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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 2. Obrada AKTIVACIJE (Pretplate ili One-time kupovine)
    if (
      payload.type === "subscription.created" || 
      payload.type === "subscription.updated" ||
      payload.type === "payment.success" ||
      payload.type === "license.created"
    ) {
      const userEmail = payload.objects?.user?.email || payload.user?.email;
      const licenseId = payload.objects?.license?.id || payload.license?.id;
      const planId = payload.objects?.plan?.id || payload.plan?.id;
      
            // Freemius šalje billing_cycle (1=mesecno, 12=godisnje, 0=one-time)
      const billingCycle = payload.objects?.payment?.billing_cycle;
      
      // Sigurna provera: Ako postoji subscription objekat ILI je billingCycle veći od 0, to je pretplata
      const isSubscription = 
        !!payload.objects?.subscription || 
        (billingCycle > 0);

      if (!userEmail) {
        console.error("[webhook] No email found in payload");
        return res.status(400).send("No email found");
      }

      // Prvo proverimo da li korisnik već postoji
      const { data: existingUser } = await supabase
        .from("pro_users")
        .select("credits, license_id")
        .eq("email", userEmail)
        .maybeSingle();

      // Zaštita od duplog slanja (retry) istog događaja
      const currentLicenseId = existingUser?.license_id?.toString() || null;
      if (currentLicenseId && licenseId && currentLicenseId === licenseId.toString()) {
        console.log(`[webhook] License ${licenseId} already processed. Ignoring.`);
        return res.status(200).json({ received: true, note: "Already processed" });
      }

      const currentCredits = existingUser?.credits || 0;

            // Ako je pretplata, upali is_active i resetuj kredite na 0.
      // Ako je one-time, ugasi is_active i dodaj 1 kredit.
      const updateData = {
        email: userEmail,
        license_id: licenseId?.toString() || null,
        plan_id: planId?.toString() || null,
        is_active: isSubscription ? true : false, // Eksplicitno postavljamo false za one-time
        credits: isSubscription ? 0 : currentCredits + 1
      };

      const { error } = await supabase.from("pro_users").upsert(
        updateData,
        { onConflict: "email" }
      );

      if (error) {
        console.error("[webhook] Supabase error:", error);
        return res.status(500).send("DB Error");
      }

      console.log(`[webhook] Successfully processed ${isSubscription ? 'subscription' : 'one-time'} for: ${userEmail}`);
    }
    
    // 3. Obrada OTKAZIVANJA (Kada pretplata istekne ili se otkaže)
    else if (
      payload.type === "subscription.cancelled" || 
      payload.type === "subscription.expired"
    ) {
      const userEmail = payload.objects?.user?.email || payload.user?.email;
      
      if (userEmail) {
        const { error } = await supabase
          .from("pro_users")
          .update({ is_active: false })
          .eq("email", userEmail.toLowerCase().trim());
          
        if (!error) {
          console.log(`[webhook] Deactivated Pro subscription for: ${userEmail}`);
        }
      }
    }

    // Uvek vrati 200 Freemiusu da zna da smo primili
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("[webhook] Error:", error);
    return res.status(500).send("Internal Server Error");
  }
}