// ui.js — stabilan init, aktivna dugmad i “ghost session” cleanup

// --- KONFIG ---
const CANON_ORIGIN = "https://qr-expiry-links.vercel.app";
const AUTH_LS_KEY  = "sb-xyfacudywygreaquvzjr-auth-token";

// Ako nisi na kanonskom hostu, prebaci (sesija je vezana za origin).
try {
  if (typeof window !== "undefined" && window.location.origin !== CANON_ORIGIN) {
    window.location.replace(
      CANON_ORIGIN + window.location.pathname + window.location.search + window.location.hash
    );
  }
} catch { /* no-op */ }

// Supabase kredencijali
// --- DOM refs ---
const urlInput      = document.getElementById("urlInput");
const expiryInput   = document.getElementById("expiryInput");
const tokenInput    = document.getElementById("tokenInput");
const generateBtn   = document.getElementById("generateBtn");

const resultCard    = document.getElementById("resultCard");
const qrcodeCanvas  = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint    = document.getElementById("expiryHint");
const countdownEl   = document.getElementById("countdown");
const copyBtn       = document.getElementById("copyBtn");
const downloadBtn   = document.getElementById("downloadBtn");      // PNG
const downloadSvgBtn= document.getElementById("downloadSvgBtn");   // SVG (Pro)

// Modali
const proModal          = document.getElementById("proModal");
const getProBtn         = document.getElementById("getProBtn");
const closeProModal     = document.getElementById("closeProModal");

const successModal      = document.getElementById("successModal");
const closeSuccessModal = document.getElementById("closeSuccessModal");
const successCode       = document.getElementById("successCode");
const successCopyBtn    = document.getElementById("successCopyBtn");

// Auth modal
const authModal      = document.getElementById("authModal");
const closeAuthModal = document.getElementById("closeAuthModal");
const googleLoginBtn = document.getElementById("googleLoginBtn");

// --- state/utility ---
let expiryTimer, countdownTimer, lastRedirectUrl = "", statusPollTimer = null;
let supa = null;
let linkExpired = false; // kontrola ponašanja PNG/SVG dugmadi nakon isteka

// [PRO LOGO OVERLAY] — global logo data URL setter + rounded rect helper
let __qrLogoDataUrl = null;
try {
  window.setQrLogoDataUrl = function (dataUrl) {
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      __qrLogoDataUrl = dataUrl;
    } else {
      __qrLogoDataUrl = null; // ignore invalid / non-data URLs (avoid taint)
    }
  };
} catch {}
function __drawRoundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.min(w, h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- LocalStorage helpers ---
function readLocalAuthObj() {
  try { const raw = localStorage.getItem(AUTH_LS_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function localAuthEmail() {
  const o = readLocalAuthObj();
  return o?.user?.email || o?.currentSession?.user?.email || o?.session?.user?.email || null;
}
function localAccessToken() {
  const o = readLocalAuthObj();
  return o?.access_token || o?.currentSession?.access_token || o?.session?.access_token || null;
}
function localAuthExpired() {
  const o = readLocalAuthObj();
  const exp = o?.expires_at || o?.currentSession?.expires_at || o?.session?.expires_at;
  if (!exp) return false;
  const ms = typeof exp === "number" ? exp * 1000 : Date.parse(exp);
  return Number.isFinite(ms) && Date.now() > ms;
}
function clearLocalAuth() {
  try { localStorage.removeItem(AUTH_LS_KEY); } catch {}
}

async function getAccessToken() {
  // koristi SDK kad postoji, inače LS fallback
  if (!supa) return localAccessToken();
  try {
    const { data: { session } } = await supa.auth.getSession();
    return session?.access_token || localAccessToken();
  } catch {
    return localAccessToken();
  }
}

function formatCountdown(ms) {
  ms = Math.max(0, ms|0);
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}
function setDownloadButtonsEnabled(enabled){
  try {
    if (downloadBtn)   { downloadBtn.disabled = !enabled; }
    if (downloadSvgBtn){ downloadSvgBtn.disabled = !enabled; }
  } catch {}
}
function startCountdown(iso){
  const end=new Date(iso).getTime();
  clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    const left=end-Date.now();
    if(left<=0){
      clearInterval(countdownTimer);
      countdownEl.textContent="Expired";
      const ctx=qrcodeCanvas.getContext("2d");
      ctx.clearRect(0,0,qrcodeCanvas.width,qrcodeCanvas.height);
      generatedLink.textContent="";
      expiryHint.textContent="This link has expired.";
      linkExpired = true;
      setDownloadButtonsEnabled(false); // PNG/SVG ne reaguju nakon isteka
      return;
    }
    countdownEl.textContent=formatCountdown(left);
  },1000);
}

// --- Create API caller ---
async function createLink(url, minutes, token) {
  const headers = { "Content-Type": "application/json" };
  const jwt = await getAccessToken();
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return fetchJSON("/api/create", {
    method: "POST",
    headers,
    body: JSON.stringify({ url, minutes, token }),
  }, 15000);
}

// --- fetch JSON helper ---
async function fetchJSON(url, opts={}, timeoutMs=15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function setLoading(state) {
  if (!generateBtn) return;
  generateBtn.disabled = state;
  generateBtn.textContent = state ? "Generating..." : "Generate QR";
}

// --- UI helpers (modali, auth UI) ---
function openModal(el){ if(!el) return; el.classList.remove("hidden"); }
function closeModal(el){ if(!el) return; el.classList.add("hidden"); }

async function refreshAuthUI() {
  try {
    if (localAuthExpired()) clearLocalAuth();

    let email = null;
    if (supa) {
      const { data: { session } } = await supa.auth.getSession();
      email = session?.user?.email || null;
    }
    if (!email) email = localAuthEmail();

    if (authOpenBtn) {
      authOpenBtn.textContent = "Sign in";
      authOpenBtn.style.display = email ? "none" : "";
    }
    if (signOutBtn)  signOutBtn.style.display = email ? "" : "none";
    if (userBadge) { userBadge.style.display = email ? "" : "none"; userBadge.textContent = email || ""; }

    console.info("[auth] UI:", email ? `signed-in as ${email}` : "signed-out");
  } catch (e) {
    console.warn("[auth] refreshAuthUI error:", e);
  }
}

// --- Bind UI once ---
function bindUI(){

  // Pro modal open/close
  getProBtn?.addEventListener("click",(e)=>{e.preventDefault();openModal(proModal);});
  closeProModal?.addEventListener("click",()=>closeModal(proModal));
  proModal?.addEventListener("click",(e)=>{ if(e.target&&e.target.matches(".modal-overlay,[data-close='modal']")) closeModal(proModal); });

  // Auth modal
  authOpenBtn?.addEventListener("click",(e)=>{e.preventDefault();openModal(authModal);});
  closeAuthModal?.addEventListener("click",()=>closeModal(authModal));
  authModal?.addEventListener("click",(e)=>{ if(e.target && e.target.matches(".modal-overlay,[data-close='auth']")) closeModal(authModal); });

  // Google login
  googleLoginBtn?.addEventListener("click", async ()=>{
    try {
      await ensureSupabase();
      if (!supa) { alert("Auth not ready."); return; }
      const { error } = await supa.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${CANON_ORIGIN}/auth.html` }
      });
      if (error) throw error;
    } catch (e) {
      console.error("login error:", e);
      alert("Login failed.");
    }
  });

  // Sign out
  signOutBtn?.addEventListener("click", async () => {
    try { if (supa) await supa.auth.signOut(); } catch {}
    clearLocalAuth();
    await refreshAuthUI();
  });

  // Success modal buttons
  successCopyBtn?.addEventListener("click", async ()=>{
    try{ await navigator.clipboard.writeText(successCode.value||successCode.textContent||""); successCopyBtn.textContent="Copied!"; setTimeout(()=>successCopyBtn.textContent="Copy",1200);}catch{ alert("Could not copy."); }
  });
  document.getElementById("applyCodeBtn")?.addEventListener("click", ()=>{
    tokenInput.value = (successCode.value||successCode.textContent||"");
    closeModal(successModal);
    generateBtn?.focus();
  });
  closeSuccessModal?.addEventListener("click", ()=>closeModal(successModal));
  successModal?.addEventListener("click",(e)=>{ if(e.target&&e.target.matches(".modal-overlay,[data-close='success']")) closeModal(successModal); });

  // Generate flow
  generateBtn?.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    const minutes = parseInt(expiryInput.value, 10);
    const token = (tokenInput?.value || "").trim();

    if (!/^https?:\/\//i.test(url)) { alert("Please enter a valid URL (include https://)."); return; }
    if (!Number.isFinite(minutes) || minutes < 1) { alert("Expiry must be at least 1 minute."); return; }

    clearTimeout(expiryTimer);
    clearInterval(countdownTimer);
    setLoading(true);

    const safety = setTimeout(() => setLoading(false), 9000);

    try {
      const created = await createLink(url, minutes, token);
      // redirect URL je /go/:id (postoji rewrite) — ostavljam kako je bilo u tvojoj verziji
      const redirectUrl = `${window.location.origin}/go/${created.id}`;
      lastRedirectUrl = redirectUrl;

      // reset state (omogući preuzimanje dok traje)
      linkExpired = false;
      setDownloadButtonsEnabled(true);

      generatedLink.textContent = redirectUrl;
      generatedLink.href = redirectUrl;
      try { QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 512, margin: 1 }, (err)=>{ if(err)console.error(err); }); } catch(e){ console.warn("QRCode draw fail:", e); }
      resultCard.classList.remove("hidden");

      const endLocal = new Date(created.expires_at);
      expiryHint.textContent = `Plan: ${(created.plan || "free").toUpperCase()} • Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

      // Pro-only SVG dugme (vidljivo samo ako je plan 'pro')
      if (downloadSvgBtn) {
        downloadSvgBtn.style.display = (created.plan === "pro") ? "" : "none";
      }

      // Auto-clear po isteku
      expiryTimer = setTimeout(() => {
        const ctx=qrcodeCanvas.getContext("2d");
        ctx.clearRect(0,0,qrcodeCanvas.width,qrcodeCanvas.height);
        generatedLink.textContent="";
        expiryHint.textContent="This link has expired.";
        countdownEl.textContent="Expired";
        linkExpired = true;
        setDownloadButtonsEnabled(false);
      }, created.minutes*60_000);
      startCountdown(created.expires_at);
    } catch (err) {
      console.error("Create error:", err);
      alert(err.message || "Could not create link.");
    } finally {
      clearTimeout(safety);
      setLoading(false);
    }
  });

  // Copy
  copyBtn?.addEventListener("click", async () => {
    try {
      if (!lastRedirectUrl) return;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(lastRedirectUrl);
        copyBtn.textContent="Copied!";
        setTimeout(()=>copyBtn.textContent="Copy link",1200);
      } else {
        const ta=document.createElement("textarea");
        ta.value=lastRedirectUrl; document.body.appendChild(ta);
        ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
    } catch { alert("Could not copy link."); }
  });

  // Download PNG — [PRO LOGO OVERLAY] (samo za Pro i ako je setovan logo)
  downloadBtn?.addEventListener("click", async () => {
    if (linkExpired) return; // ne reaguje kad istekne
    try {
      const isProUI = (downloadSvgBtn && downloadSvgBtn.style.display !== "none");
      if (isProUI && __qrLogoDataUrl) {
        const w = qrcodeCanvas.width, h = qrcodeCanvas.height;
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(qrcodeCanvas, 0, 0, w, h);

        // white plate ~28% + rounded 8% radius
        const plateSize = Math.round(Math.min(w, h) * 0.28);
        const plateX = Math.round((w - plateSize) / 2);
        const plateY = Math.round((h - plateSize) / 2);
        ctx.fillStyle = "#ffffff";
        __drawRoundedRect(ctx, plateX, plateY, plateSize, plateSize, Math.round(plateSize * 0.08));
        ctx.fill();

        // draw logo ~21%
        const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = __qrLogoDataUrl; });
        const logoSize = Math.round(Math.min(w, h) * 0.21);
        const logoX = Math.round((w - logoSize) / 2);
        const logoY = Math.round((h - logoSize) / 2);
        ctx.drawImage(img, logoX, logoY, logoSize, logoSize);

        const url = c.toDataURL("image/png");
        const a=document.createElement("a"); a.href=url; a.download="qr-link.png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } else {
        const url=qrcodeCanvas.toDataURL("image/png");
        const a=document.createElement("a"); a.href=url; a.download="qr-link.png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }
    } catch { alert("Could not download QR."); }
  });

  // Download SVG (Pro) — [PRO LOGO OVERLAY] (samo za Pro i ako je setovan logo)
  downloadSvgBtn?.addEventListener("click", async () => {
    if (linkExpired) return; // ne reaguje kad istekne
    try {
      if (!downloadSvgBtn || downloadSvgBtn.style.display === "none") return; // samo za Pro
      if (!lastRedirectUrl) return;

      // Generiši SVG string preko qrcode biblioteke
      let svgText;
      if (QRCode?.toString) {
        svgText = await QRCode.toString(lastRedirectUrl, { type: "svg", width: 200, margin: 1 });
      } else {
        throw new Error("SVG generator not available");
      }

      // dodaj belu pločicu i logo ako imamo dataURL
      if (__qrLogoDataUrl) {
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(svgText, "image/svg+xml");
          const svg = doc.documentElement;

          // odredi size iz viewBox-a ili width/height; postavi viewBox ako ne postoji
          let size = 200;
          const vb = svg.getAttribute("viewBox");
          if (vb) {
            const p = vb.split(/\s+/).map(Number);
            if (p.length === 4) size = Math.min(p[2], p[3]) || size;
          } else {
            const wAttr = parseInt(svg.getAttribute("width") || "200", 10);
            const hAttr = parseInt(svg.getAttribute("height") || String(wAttr), 10);
            size = Math.min(wAttr, hAttr) || size;
            svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
          }
          svg.setAttribute("width", String(size));
          svg.setAttribute("height", String(size));

          // pločica + logo
          const plateSize = Math.round(size * 0.28);
          const plateX = Math.round((size - plateSize) / 2);
          const plateY = plateX;

          const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("x", String(plateX));
          rect.setAttribute("y", String(plateY));
          rect.setAttribute("width", String(plateSize));
          rect.setAttribute("height", String(plateSize));
          rect.setAttribute("rx", String(Math.round(plateSize * 0.08)));
          rect.setAttribute("fill", "#ffffff");

          const img = doc.createElementNS("http://www.w3.org/2000/svg", "image");
          const logoSize = Math.round(size * 0.21);
          const logoX = Math.round((size - logoSize) / 2);
          const logoY = logoX;
          img.setAttributeNS("http://www.w3.org/1999/xlink", "href", __qrLogoDataUrl);
          img.setAttribute("x", String(logoX));
          img.setAttribute("y", String(logoY));
          img.setAttribute("width", String(logoSize));
          img.setAttribute("height", String(logoSize));
          img.setAttribute("preserveAspectRatio", "xMidYMid meet");

          svg.appendChild(rect);
          svg.appendChild(img);

          const serializer = new XMLSerializer();
          svgText = serializer.serializeToString(svg);
        } catch {
          // fallback: ostavi čist QR
        }
      }

      const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "qr-link.svg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { alert("Could not download SVG."); }
  });

}

// --- Checkout helpers ---
function startStatusPolling(sessionId){
  stopStatusPolling();
  statusPollTimer=setInterval(async()=>{
    try{
      const data = await fetchJSON(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`, {}, 8000);
      if(data?.ready&&data?.token){
        stopStatusPolling();
        showSuccessModal(data.token,sessionId);
      }
    }catch{/* tiho */}
  },2000);
}
function stopStatusPolling(){
  if(statusPollTimer){ clearInterval(statusPollTimer); statusPollTimer=null; }
}

function showSuccessModal(token, sessionId) {
  if (!successModal) return;
  const tokenSpan = document.getElementById("successToken");
  if (tokenSpan) tokenSpan.textContent = token || "";
  const sessionSpan = document.getElementById("successSession");
  if (sessionSpan) sessionSpan.textContent = sessionId || "";

  const resendLink = document.getElementById("resendLink");
  if(resendLink){
    const subject=encodeURIComponent("QR Expiry Links - Resend my code");
    const body=encodeURIComponent(`Hello,\nI completed the payment but did not receive a Pro code.\nMy sessionId is: ${sessionId}\nPlease resend my Pro code.`);
    resendLink.href=`mailto:support@example.com?subject=${subject}&body=${body}`;
  }
  openModal(successModal);
  // opcionalno linkovanje uz nalog
  linkTokenToAccount(token).then((ok)=>{
    if (ok) {
      const h2 = document.getElementById("successModalTitle");
      if (h2) h2.textContent = "Pro code linked to your account 🎉";
    }
  });
}

async function linkTokenToAccount(token) {
  try {
    const jwt = await getAccessToken();
    if (!jwt) return false;
    const r = await fetch("/api/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
      body: JSON.stringify({ token })
    });
    return r.ok;
  } catch { return false; }
}

// --- Supabase init (ESM → UMD fallback) ---
async function ensureSupabase() {
  if (supa) return;
  try {
    const mod = await import("https://esm.sh/@supabase/supabase-js@2");
    supa = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.info("[ui] supabase via ESM");
  } catch (e) {
    console.warn("[ui] ESM failed, falling back to UMD:", e?.message || e);
    await new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.async = true; s.onload = () => ok(); s.onerror = () => err(new Error("UMD load failed"));
      document.head.appendChild(s);
    });
    if (!window.supabase?.createClient) throw new Error("supabase UMD not available");
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.info("[ui] supabase via UMD");
  }
}

async function normalizeGhostSession() {
  try {
    const obj = readLocalAuthObj();
    if (!obj) return;
    if (localAuthExpired()) {
      clearLocalAuth();
      return;
    }
  } catch {}
}

async function initAuth(){
  try {
    await ensureSupabase();
    await normalizeGhostSession();
    await refreshAuthUI();

    console.info("[ui] auth ready");
  } catch (e) {
    console.warn("[ui] auth disabled (could not init):", e?.message || e);
  }
}

// --- Start ---
(function start() {
  console.info("[ui] init @", location.origin);
  bindUI();   // klikovi odmah
  initAuth(); // auth u pozadini
})();
