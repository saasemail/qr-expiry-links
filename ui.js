// ui.js — stabilan init, aktivna dugmad i “ghost session” cleanup
// + SVG (Pro only) i blokada PNG/SVG kad istekne link

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
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

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
const downloadBtn   = document.getElementById("downloadBtn");
const downloadSvgBtn= document.getElementById("downloadSvgBtn"); // NEW

// Modali
const proModal          = document.getElementById("proModal");
const getProBtn         = document.getElementById("getProBtn");
const closeProModal     = document.getElementById("closeProModal");

const successModal      = document.getElementById("successModal");
const closeSuccessModal = document.getElementById("closeSuccessModal");
const successCode       = document.getElementById("successCode");
const copyCodeBtn       = document.getElementById("copyCodeBtn");
const applyCodeBtn      = document.getElementById("applyCodeBtn");
const resendLink        = document.getElementById("resendLink");

// Auth UI
const userBadge      = document.getElementById("userBadge");
const authOpenBtn    = document.getElementById("authOpenBtn"); // Sign in / Account (ne diramo)
const signOutBtn     = document.getElementById("signOutBtn");
const authModal      = document.getElementById("authModal");
const closeAuthModal = document.getElementById("closeAuthModal");
const googleLoginBtn = document.getElementById("googleLoginBtn");

// --- state/utility ---
let expiryTimer, countdownTimer, lastRedirectUrl = "", statusPollTimer = null;
let supa = null;
let isProPlan = false;   // NEW: da znamo da li treba SVG
let linkExpired = false; // NEW: da blokiramo download posle isteka

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
  if (!supa) return localAccessToken();
  try {
    const { data: { session } } = await supa.auth.getSession();
    return session?.access_token || localAccessToken();
  } catch {
    return localAccessToken();
  }
}

// --- Fetch helper ---
async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) {
      const msg = (data && (data.message || data.error || data.msg)) || text || "Request failed";
      throw new Error(msg);
    }
    return data;
  } finally { clearTimeout(t); }
}

// --- UI helpers (modals) ---
function onEsc(e){ if(e.key==="Escape"){ [proModal,successModal,authModal].forEach(closeModal); } }
function trapTab(e){ const open=document.querySelector(".modal.open"); if(!open||e.key!=="Tab") return;
  const f=open.querySelectorAll("button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])");
  if(!f.length) return; const first=f[0],last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();}
  else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();}
}
function openModal(m){ if(!m) return; m.classList.add("open"); m.setAttribute("aria-hidden","false");
  document.addEventListener("keydown", onEsc); document.addEventListener("keydown", trapTab); }
function closeModal(m){ if(!m) return; m.classList.remove("open"); m.setAttribute("aria-hidden","true");
  document.removeEventListener("keydown", onEsc); document.removeEventListener("keydown", trapTab); }

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

    if (userBadge) { userBadge.style.display = email ? "" : "none"; userBadge.textContent = email || ""; }
    if (authOpenBtn) authOpenBtn.textContent = email ? "Account" : "Sign in";
    if (signOutBtn)  signOutBtn.style.display = email ? "" : "none";

    console.info("[auth] UI:", email ? `signed-in as ${email}` : "signed-out");
  } catch (e) {
    console.warn("[auth] refreshAuthUI error:", e);
  }
}

// --- Countdown ---
function formatCountdown(ms){
  if(ms<=0) return "00:00:00";
  const sec=Math.floor(ms/1000);
  const d=Math.floor(sec/86400);
  const h=Math.floor((sec%86400)/3600);
  const m=Math.floor((sec%3600)/60);
  const s=sec%60;
  const pad=n=>String(n).padStart(2,"0");
  return d>0?`${d}d ${pad(h)}:${pad(m)}:${pad(s)}`:`${pad(h)}:${pad(m)}:${pad(s)}`;
}
function disableOnExpireUI(){
  linkExpired = true;
  setDownloadEnabled(false);
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
      disableOnExpireUI(); // NEW
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

function setLoading(state) {
  if (!generateBtn) return;
  generateBtn.disabled = state;
  generateBtn.textContent = state ? "Generating..." : "Generate QR";
}

// --- Download helpers (NEW) ---
function setProUI(isPro){
  if (downloadSvgBtn) downloadSvgBtn.style.display = isPro ? "" : "none";
}
function setDownloadEnabled(enabled){
  [downloadBtn, downloadSvgBtn].forEach(btn=>{
    if(!btn) return;
    btn.disabled = !enabled;
    btn.setAttribute("aria-disabled", String(!enabled));
  });
}

// --- UI bindings (uvek aktivni) ---
function bindUI() {
  // Auth modal
  authOpenBtn?.addEventListener("click",(e)=>{e.preventDefault();openModal(authModal);});
  closeAuthModal?.addEventListener("click",()=>closeModal(authModal));
  authModal?.addEventListener("click",(e)=>{ if(e.target && e.target.matches(".modal-overlay,[data-close='auth']")) closeModal(authModal); });

  // Google sign-in
  googleLoginBtn?.addEventListener("click", async () => {
    try {
      if (!supa) await initAuth();
      if (!supa) { alert("Auth not ready. Try again."); return; }
      await supa.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${CANON_ORIGIN}/auth.html` } });
    } catch (e) { alert(e?.message || "Google sign-in failed."); }
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
    btn.addEventListener("click", async (e)=>{
      e.preventDefault();
      const tier = Number(btn.dataset.tier||0);
      if(!tier) return;
      try {
        const { session_id } = await fetchJSON("/api/checkout-session", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ tier })
        }, 10000);
        startStatusPolling(session_id);
      } catch(e){
        alert("Could not start checkout session.");
        console.error(e);
      } finally {
        closeModal(proModal);
        tokenInput?.focus();
      }
    });
  });

  // Success modal buttons
  copyCodeBtn?.addEventListener("click", async ()=>{
    try{ await navigator.clipboard.writeText(successCode.value||""); copyCodeBtn.textContent="Copied!"; setTimeout(()=>copyCodeBtn.textContent="Copy",1200);}catch{ alert("Could not copy."); }
  });
  applyCodeBtn?.addEventListener("click", ()=>{ tokenInput.value=successCode.value||""; closeModal(successModal); generateBtn?.focus(); });
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
      const redirectUrl = `${window.location.origin}/go/${created.id}`;
      lastRedirectUrl = redirectUrl;
      isProPlan = String(created.plan || "").toLowerCase() === "pro";
      linkExpired = false;
      setProUI(isProPlan);
      setDownloadEnabled(true);

      generatedLink.textContent = redirectUrl;
      generatedLink.href = redirectUrl;
      try { QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 200 }, (err) => { if (err) console.error(err); }); } catch(e){ console.warn("QRCode draw fail:", e); }
      resultCard.classList.remove("hidden");

      const endLocal = new Date(created.expires_at);
      expiryHint.textContent = `Plan: ${(created.plan || "free").toUpperCase()} • Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;
      expiryTimer = setTimeout(() => {
        const ctx=qrcodeCanvas.getContext("2d");
        ctx.clearRect(0,0,qrcodeCanvas.width,qrcodeCanvas.height);
        generatedLink.textContent="";
        expiryHint.textContent="This link has expired.";
        countdownEl.textContent="Expired";
        disableOnExpireUI(); // NEW
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

  // Copy & Download
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

  downloadBtn?.addEventListener("click", () => {
    if (linkExpired) return; // NEW: blokada posle isteka
    try {
      const url=qrcodeCanvas.toDataURL("image/png");
      const a=document.createElement("a");
      a.href=url; a.download="qr-link.png";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch { alert("Could not download PNG."); }
  });

  // NEW: SVG download (radi samo kad je Pro i dok link važi)
  downloadSvgBtn?.addEventListener("click", () => {
    if (!isProPlan || linkExpired || !lastRedirectUrl) return;
    try {
      QRCode.toString(lastRedirectUrl, { type: "svg" }, (err, svg) => {
        if (err || !svg) { alert("Could not generate SVG."); return; }
        const blob = new Blob([svg], { type: "image/svg+xml" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "qr-link.svg";
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
      });
    } catch { alert("Could not download SVG."); }
  });

  // On-load: ?session_id=...
  (function () {
    const sid = new URLSearchParams(location.search).get("session_id");
    if (!sid) return;
    (async function poll() {
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

  // Prefill code
  try {
    const saved = localStorage.getItem("pro_code");
    if (saved && !tokenInput.value) tokenInput.value = saved;
  } catch {}

  // Inicijalno stanje
  setProUI(false);
  setDownloadEnabled(false);
  refreshAuthUI();
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
function stopStatusPolling(){ if(statusPollTimer){ clearInterval(statusPollTimer); statusPollTimer=null; } }

function showSuccessModal(token,sessionId){
  if (successCode) successCode.value = token || "";
  try { localStorage.setItem("pro_code", token || ""); } catch {}
  if(resendLink){
    const subject=encodeURIComponent("QR Expiry Links - Resend my code");
    const body=encodeURIComponent(`Hello,\nI completed the payment. My sessionId is: ${sessionId}\nPlease resend my Pro code.`);
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
async function loadSupabaseCreateClient() {
  try {
    const mod = await import("https://esm.sh/@supabase/supabase-js@2");
    console.info("[ui] supabase via ESM");
    return mod.createClient;
  } catch (e) {
    console.warn("[ui] ESM failed, falling back to UMD:", e?.message || e);
    await new Promise((ok, err) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.async = true; s.onload = () => ok(); s.onerror = () => err(new Error("UMD load failed"));
      document.head.appendChild(s);
    });
    if (!window.supabase?.createClient) throw new Error("supabase UMD not available");
    console.info("[ui] supabase via UMD");
    return (url, key, opts) => window.supabase.createClient(url, key, opts);
  }
}

async function normalizeGhostSession() {
  try {
    const hasLS = !!localAccessToken();
    const { data: { session } } = await supa.auth.getSession();
    if (hasLS && !session) {
      clearLocalAuth();
      await refreshAuthUI();
      console.info("[ui] ghost session cleared");
    }
  } catch {}
}

async function initAuth() {
  if (supa) return; // već podignut
  try {
    const createClient = await loadSupabaseCreateClient();
    supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
    });

    for (let i = 0; i < 10; i++) {
      if (localAuthEmail()) break;
      await sleep(150);
    }
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
