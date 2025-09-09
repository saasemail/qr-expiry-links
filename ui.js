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
const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIs...CI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

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
const copyCodeBtn       = document.getElementById("successCopyBtn");
const applyCodeBtn      = document.getElementById("applyCodeBtn");
const resendLink        = document.getElementById("resendLink");

// Auth modal / dugmad
const authModal      = document.getElementById("authModal");
const authOpenBtn    = document.getElementById("openAuthModal");
const closeAuthModal = document.getElementById("closeAuthModal");
const googleLoginBtn = document.getElementById("googleLoginBtn");
const signOutBtn     = document.getElementById("signOutBtn");
const userBadge      = document.getElementById("userBadge");

// --- STATE ---
let expiryTimer = null;
let countdownTimer = null;
let lastRedirectUrl = "";
let statusPollTimer = null;
let linkExpired = false; // kontrola ponašanja PNG/SVG dugmadi nakon isteka
let currentPlan = "free"; // 'free' ili 'pro' — set na create
let __qrLogoDataUrl = null; // data: URL za Pro logo overlay (PNG/SVG)
try {
  window.setQrLogoDataUrl = (dataUrl) => {
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      __qrLogoDataUrl = dataUrl;
    } else {
      __qrLogoDataUrl = null; // ignorišemo remote URL bez CORS-a da ne „uprljamo“ canvas/SVG
    }
  };
} catch {}

// --- LS helpers ---
function readJSON(key){ try{ const v=localStorage.getItem(key); return v?JSON.parse(v):null; }catch{return null;} }
function writeJSON(key,val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch{} }
function del(key){ try{ localStorage.removeItem(key); }catch{} }

// Auth token čuvamo pod AUTH_LS_KEY (kompatibilno sa Supabase SDK zapisom)
function localAuthObj(){ return readJSON(AUTH_LS_KEY); }
function localAuthEmail(){
  const o = localAuthObj();
  return o?.user?.email || o?.user?.user_metadata?.email || null;
}
function localAuthExpired(){
  const o = localAuthObj();
  const exp = o?.expires_at || o?.session?.expires_at || o?.currentSession?.expires_at;
  if (!exp) return false;
  const ms = typeof exp === "number" ? exp*1000 : Date.parse(exp);
  return Number.isFinite(ms) && Date.now() > ms;
}
function clearLocalAuth(){ del(AUTH_LS_KEY); }

// Supabase client (ako je global supabase lib prisutan)
let supa = null;
try {
  if (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY) {
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch {}

// Access token iz SDK ili LS
async function getAccessToken() {
  if (!supa) {
    const o = localAuthObj();
    if (o && !localAuthExpired()) return o.access_token || null;
    return null;
  }
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session?.access_token) return session.access_token;
  } catch {}
  const o = localAuthObj();
  if (o && !localAuthExpired()) return o.access_token || null;
  return null;
}

// --- fetch helper ---
async function fetchJSON(url, opts={}, timeout=15000) {
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// --- Modal helpers (open/close + focus trap) ---
function openModal(el){ if(!el) return; el.classList.remove("hidden"); }
function closeModal(el){ if(!el) return; el.classList.add("hidden"); }

// --- Countdown ---
function startCountdown(expiresAtIso){
  try { clearInterval(countdownTimer); } catch {}
  const end = Date.parse(expiresAtIso);
  countdownTimer = setInterval(()=>{
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      countdownEl.textContent="Expired";
      return;
    }
    const s = Math.floor(Math.max(0,left)/1000);
    const m = Math.floor(s/60); const ss = s%60;
    countdownEl.textContent = `${m}m ${ss}s`;
  }, 1000);
}

function setLoading(flag){
  if (generateBtn) generateBtn.disabled = !!flag;
  if (copyBtn)     copyBtn.disabled = !!flag;
}

function setDownloadButtonsEnabled(enabled){
  if (downloadBtn)    downloadBtn.disabled    = !enabled;
  if (downloadSvgBtn) downloadSvgBtn.disabled = !enabled;
}

// --- Auth UI ---
async function refreshAuthUI() {
  try {
    if (localAuthExpired()) clearLocalAuth();

    let email = null;
    if (supa) {
      const { data: { session } } = await supa.auth.getSession();
      email = session?.user?.email || null;
    }
    if (!email) email = localAuthEmail();

    // NIKAD "Account": ili "Sign in" (ako si izlogovan) ili ništa (ako si ulogovan)
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

// --- INIT ---
window.addEventListener("DOMContentLoaded", async () => {
  try { await refreshAuthUI(); } catch {}

  // Restore poslednji URL
  try {
    const last = sessionStorage.getItem("qr-last-url");
    if (last && urlInput) urlInput.value = last;
  } catch {}

  urlInput?.addEventListener("change", ()=>{
    try { sessionStorage.setItem("qr-last-url", String(urlInput.value||"").trim()); } catch {}
  });

  // Sign in (Google)
  googleLoginBtn?.addEventListener("click", async ()=>{
    try {
      if (!supa) { alert("Auth not ready."); return; }
      const { data, error } = await supa.auth.signInWithOAuth({
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

  // Pro modal
  getProBtn?.addEventListener("click",(e)=>{e.preventDefault();openModal(proModal);});
  closeProModal?.addEventListener("click",()=>closeModal(proModal));
  proModal?.addEventListener("click",(e)=>{ if(e.target&&e.target.matches(".modal-overlay,[data-close='modal']")) closeModal(proModal); });

  // Checkout polling
  document.querySelectorAll(".plan-select").forEach((btn)=>{
    btn.addEventListener("click", async ()=>{
      try {
        const res = await fetch("/api/checkout-session", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ plan: btn.dataset.plan || "pro" }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const js = await res.json();
        if (js?.url) window.location.href = js.url;
      } catch (err) {
        console.error("checkout err:", err);
        alert("Could not start checkout.");
      }
    });
  });

  // Success modal buttons
  copyCodeBtn?.addEventListener("click", async ()=>{
    try{ await navigator.clipboard.writeText(successCode.value||successCode.textContent||""); copyCodeBtn.textContent="Copied!"; setTimeout(()=>copyCodeBtn.textContent="Copy",1200);}catch{ alert("Could not copy."); }
  });
  applyCodeBtn?.addEventListener("click", ()=>{
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
    if (!minutes || minutes<=0) { alert("Minutes must be > 0."); return; }

    setLoading(true);
    try {
      // opcioni token u auth headeru
      const headers = { "Content-Type":"application/json" };
      const at = await getAccessToken();
      if (at) headers.Authorization = `Bearer ${at}`;

      const res = await fetch("/api/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ url, minutes, token })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created = await res.json();
      if (!created?.redirect || !created?.expires_at) throw new Error("Malformed response.");

      // Drži redirect i resetuj state
      lastRedirectUrl = created.redirect;
      linkExpired = false;
      setDownloadButtonsEnabled(true);

      // Prikaz QR pregleda (512) — export ide na 1024, nezavisno
      try { QRCode.toCanvas(qrcodeCanvas, created.redirect, { width: 512, margin: 1 }, (err)=>{ if(err)console.error(err); }); } catch(e){ console.warn("QRCode draw fail:", e); }
      resultCard.classList.remove("hidden");

      const endLocal = new Date(created.expires_at);
      expiryHint.textContent = `Plan: ${(created.plan || "free").toUpperCase()} • Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

      // Pro-only SVG dugme
      if (downloadSvgBtn) {
        downloadSvgBtn.style.display = (created.plan === "pro") ? "" : "none";
      }
      currentPlan = created.plan || "free";

      // Auto-clear po isteku
      try { clearTimeout(expiryTimer); } catch {}
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
      setLoading(false);
    }

    // Popuni link
    generatedLink.textContent = lastRedirectUrl || "";
    generatedLink.href = lastRedirectUrl || "#";
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

  // Download PNG (radi samo dok važi link) — export 1024 i opcioni Pro logo overlay
  downloadBtn?.addEventListener("click", async () => {
    if (linkExpired) return; // ne reaguje kad istekne
    try {
      if (!lastRedirectUrl) return;
      const dataUrl = await buildPngDataUrl1024(lastRedirectUrl, (currentPlan === "pro") ? __qrLogoDataUrl : null);
      const a=document.createElement("a");
      a.href=dataUrl; a.download="qr-link.png";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch { alert("Could not download QR."); }
  });

  // Download SVG (Pro) — radi samo dok važi link; export 1024 + opcioni Pro logo overlay
  downloadSvgBtn?.addEventListener("click", async () => {
    if (linkExpired) return;
    try {
      if (!downloadSvgBtn || downloadSvgBtn.style.display === "none") return; // samo za Pro
      if (!lastRedirectUrl) return;

      let svgText = await buildQrSvgText1024(lastRedirectUrl);
      if (currentPlan === "pro" && __qrLogoDataUrl) {
        svgText = addLogoOverlayToSvg(svgText, __qrLogoDataUrl, { size: 1024, plateRatio: 0.28, logoRatio: 0.21 });
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
    } catch {
      alert("Could not download SVG.");
    }
  });

  // Success modal (posle kupovine / uparivanje tokena)
  function showSuccessModal(token, sessionId){
    if (!successModal) return;
    const tokenSpan = document.getElementById("successToken");
    if (tokenSpan) tokenSpan.textContent = token || "";
    const sessionSpan = document.getElementById("successSession");
    if (sessionSpan) sessionSpan.textContent = sessionId || "";

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

  // URL param ?session_id=... → poll /api/checkout-status
  (function initCheckoutStatusPoll(){
    const sid = new URLSearchParams(location.search).get("session_id");
    if (!sid) return;
    (async function poll(){
      try {
        const js = await fetchJSON(`/api/checkout-status?session_id=${encodeURIComponent(sid)}`, {}, 8000);
        if (js?.ready && js?.token) {
          showSuccessModal(js.token, sid);
          history.replaceState(null, "", location.origin + location.pathname);
          return;
        }
      } catch {}
      setTimeout(poll, 2000);
    })();
  })();

}); // DOMContentLoaded

// --- Link token to account (helper) ---
async function linkTokenToAccount(token){
  try {
    const at = await getAccessToken();
    const headers = { "Content-Type":"application/json" };
    if (at) headers.Authorization = `Bearer ${at}`;
    const res = await fetch("/api/link-token", {
      method: "POST",
      headers,
      body: JSON.stringify({ token })
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Helpers for QR export with optional Pro logo overlay ---
function drawRoundedRect(ctx, x, y, w, h, r) {
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

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function buildPngDataUrl1024(urlText, logoDataUrl) {
  // Offscreen canvas da ne diramo preview
  const size = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = size;

  await new Promise((resolve, reject) => {
    try {
      QRCode.toCanvas(c, urlText, { width: size, margin: 1 }, (err)=>{ if (err) reject(err); else resolve(); });
    } catch (e) { reject(e); }
  });

  if (logoDataUrl) {
    try {
      const ctx = c.getContext("2d");
      const plateSize = Math.round(size * 0.28);
      const plateX = Math.round((size - plateSize) / 2);
      const plateY = Math.round((size - plateSize) / 2);
      ctx.fillStyle = "#ffffff";
      drawRoundedRect(ctx, plateX, plateY, plateSize, plateSize, Math.round(plateSize * 0.08));
      ctx.fill();

      const img = await loadImage(logoDataUrl);
      const logoSize = Math.round(size * 0.21);
      const logoX = Math.round((size - logoSize) / 2);
      const logoY = Math.round((size - logoSize) / 2);
      ctx.drawImage(img, logoX, logoY, logoSize, logoSize);
    } catch {
      // ako overlay padne — vrati čist QR
    }
  }

  return c.toDataURL("image/png");
}

async function buildQrSvgText1024(urlText) {
  const svg = await QRCode.toString(urlText, { type: "svg", width: 1024, margin: 1 });
  return ensureSvgViewBox(svg, 1024);
}

function ensureSvgViewBox(svgText, size) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg.getAttribute("viewBox")) {
      svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    }
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    const serializer = new XMLSerializer();
    return serializer.serializeToString(svg);
  } catch {
    return svgText;
  }
}

function addLogoOverlayToSvg(svgText, logoDataUrl, opts={}) {
  if (!logoDataUrl || !logoDataUrl.startsWith("data:")) return svgText;
  const size = opts.size || 1024;
  const plateRatio = opts.plateRatio ?? 0.28;
  const logoRatio  = opts.logoRatio  ?? 0.21;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;

    if (!svg.getAttribute("viewBox")) {
      svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    }
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));

    const plateSize = Math.round(size * plateRatio);
    const plateX = Math.round((size - plateSize) / 2);
    const plateY = Math.round((size - plateSize) / 2);

    const plate = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    plate.setAttribute("x", String(plateX));
    plate.setAttribute("y", String(plateY));
    plate.setAttribute("width", String(plateSize));
    plate.setAttribute("height", String(plateSize));
    plate.setAttribute("rx", String(Math.round(plateSize * 0.08)));
    plate.setAttribute("fill", "#ffffff");

    const img = doc.createElementNS("http://www.w3.org/2000/svg", "image");
    const logoSize = Math.round(size * logoRatio);
    const logoX = Math.round((size - logoSize) / 2);
    const logoY = Math.round((size - logoSize) / 2);
    img.setAttributeNS("http://www.w3.org/1999/xlink", "href", logoDataUrl);
    img.setAttribute("x", String(logoX));
    img.setAttribute("y", String(logoY));
    img.setAttribute("width", String(logoSize));
    img.setAttribute("height", String(logoSize));
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");

    svg.appendChild(plate);
    svg.appendChild(img);

    const serializer = new XMLSerializer();
    return serializer.serializeToString(svg);
  } catch {
    return svgText;
  }
}
