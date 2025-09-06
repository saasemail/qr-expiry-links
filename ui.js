import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
});

console.log("[ui] BOOT ok");

// Elements
const urlInput = document.getElementById("urlInput");
const expiryInput = document.getElementById("expiryInput");
const tokenInput = document.getElementById("tokenInput");
const generateBtn = document.getElementById("generateBtn");

const resultCard = document.getElementById("resultCard");
const qrcodeCanvas = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint = document.getElementById("expiryHint");
const countdownEl = document.getElementById("countdown");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

const userBadge = document.getElementById("userBadge");
const authOpenBtn = document.getElementById("authOpenBtn");
const signOutBtn = document.getElementById("signOutBtn");

const proModal = document.getElementById("proModal");
const getProBtn = document.getElementById("getProBtn");
const closeProModal = document.getElementById("closeProModal");
const proGateHint = document.getElementById("proGateHint");

const successModal = document.getElementById("successModal");
const closeSuccessModal = document.getElementById("closeSuccessModal");
const successTokenEl = document.getElementById("successToken");
const successCopyBtn = document.getElementById("successCopyBtn");
const successApplyBtn = document.getElementById("successApplyBtn");
const resendLink = document.getElementById("resendLink");

const authModal = document.getElementById("authModal");
const closeAuthModal = document.getElementById("closeAuthModal");
const googleLoginBtn = document.getElementById("googleLoginBtn");

let expiryTimer, countdownTimer, lastRedirectUrl = "", statusPollTimer = null;

// ---- Auth UI ----
async function refreshAuthUI() {
  const { data: { session } } = await supa.auth.getSession();
  console.log("[ui] session:", session ? { user: session.user?.email } : null);
  const email = session?.user?.email;
  if (email) {
    userBadge.style.display = "";
    userBadge.textContent = email;
    authOpenBtn.textContent = "Account";
    signOutBtn.style.display = "";
    proGateHint.style.display = "none";
  } else {
    userBadge.style.display = "none";
    authOpenBtn.textContent = "Sign in";
    signOutBtn.style.display = "none";
  }
}
supa.auth.onAuthStateChange(async () => { await refreshAuthUI(); });
window.addEventListener("load", refreshAuthUI);

// ---- Modals ----
function openModal(m){ if(!m) return; m.classList.add("open"); m.setAttribute("aria-hidden","false"); document.addEventListener("keydown", onEsc); document.addEventListener("keydown", trapTab); }
function closeModal(m){ if(!m) return; m.classList.remove("open"); m.setAttribute("aria-hidden","true"); document.removeEventListener("keydown", onEsc); document.removeEventListener("keydown", trapTab); }
function onEsc(e){ if(e.key==="Escape"){ [proModal,successModal,authModal].forEach(closeModal); } }
function trapTab(e){ const open=document.querySelector(".modal.open"); if(!open||e.key!=="Tab") return; const f=open.querySelectorAll("button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])"); if(!f.length) return; const first=f[0],last=f[f.length-1]; if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();} else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();} }

authOpenBtn?.addEventListener("click",(e)=>{e.preventDefault();openModal(authModal);});
closeAuthModal?.addEventListener("click",()=>closeModal(authModal));
authModal?.addEventListener("click",(e)=>{ if(e.target && e.target.matches(".modal-overlay,[data-close='auth']")) closeModal(authModal); });

// ---- Google OAuth ----
googleLoginBtn?.addEventListener("click", async () => {
  try {
    await supa.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth.html`, queryParams: { prompt: "select_account" } }
    });
  } catch (e) {
    alert(e?.message || "Google sign-in failed.");
  }
});

signOutBtn?.addEventListener("click", async () => {
  await supa.auth.signOut();
  await refreshAuthUI();
});

// ---- Helpers ----
function setLoading(state){ if(!generateBtn) return; generateBtn.disabled = state; generateBtn.textContent = state ? "Generating..." : "Generate QR"; }
async function getAccessToken(){ const { data:{ session } } = await supa.auth.getSession(); return session?.access_token || null; }

async function createLink(url, minutes, token) {
  const headers = { "Content-Type": "application/json" };
  const jwt = await getAccessToken();
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const resp = await fetch("/api/create", {
    method: "POST",
    headers,
    body: JSON.stringify({ url, minutes, token })
  });

  if (!resp.ok) {
    if (resp.status === 401) { proGateHint.style.display = ""; openModal(authModal); throw new Error("Login required for Pro features."); }
    if (resp.status === 404) { throw new Error("/api/create not found (backend route missing)."); }
    if (resp.status === 429) { const msg = await resp.text(); throw new Error(msg || "Daily limit reached."); }
    const text = await resp.text();
    try { const maybe = JSON.parse(text); throw new Error(maybe?.message || text || "Create failed"); }
    catch { throw new Error(text || "Create failed"); }
  }
  return resp.json();
}

function formatCountdown(ms){
  if(ms<=0) return "00:00:00";
  const sec=Math.floor(ms/1000);
  const d=Math.floor(sec/86400);
  const h=Math.floor((sec%86400)/3600);
  const m=Math.floor((sec%3600)/60);
  const s=sec%60;
  const pad=n=>String(n).padStart(2,"0");
  return d>0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function clearQR(){
  try{
    const ctx=qrcodeCanvas?.getContext?.("2d");
    if(ctx){ ctx.clearRect(0,0,qrcodeCanvas.width,qrcodeCanvas.height); }
  }catch{}
}

function startCountdown(iso){
  const end=new Date(iso).getTime();
  clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    const left=end-Date.now();
    if(left<=0){
      clearInterval(countdownTimer);
      countdownEl.textContent="Expired";
      clearQR();
      generatedLink.textContent="";
      expiryHint.textContent="This link has expired.";
      return;
    }
    countdownEl.textContent=formatCountdown(left);
  }, 1000);
}

// ---- Generate flow ----
generateBtn?.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const minutes = parseInt(expiryInput.value, 10);
  const token = (tokenInput?.value || "").trim();

  if (!/^https?:\/\//i.test(url)) { alert("Please enter a valid URL (include https://)."); return; }
  if (!Number.isFinite(minutes) || minutes < 1) { alert("Expiry must be at least 1 minute."); return; }

  // Pro gating: >60 min ili pro token
  const proIntent = minutes > 60 || !!token;
  const { data: { session } } = await supa.auth.getSession();
  if (proIntent && !session) { proGateHint.style.display = ""; openModal(authModal); return; }

  clearTimeout(expiryTimer); clearInterval(countdownTimer); setLoading(true);
  try {
    const created = await createLink(url, minutes, token);
    const redirectUrl = `${window.location.origin}/go/${created.id}`;
    lastRedirectUrl = redirectUrl;

    generatedLink.textContent = redirectUrl;
    generatedLink.href = redirectUrl;

    if (window.QRCode && qrcodeCanvas) {
      QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 200 }, (err) => { if (err) console.error(err); });
    }

    resultCard.classList.remove("hidden");
    const endLocal = new Date(created.expires_at);
    expiryHint.textContent = `Plan: ${(created.plan || "free").toUpperCase()} • Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

    expiryTimer = setTimeout(() => {
      clearQR();
      generatedLink.textContent="";
      expiryHint.textContent="This link has expired.";
      countdownEl.textContent="Expired";
    }, created.minutes*60_000);

    startCountdown(created.expires_at);
  } catch (err) {
    console.error("Create error:", err);
    alert(err.message);
  } finally {
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
      ta.value=lastRedirectUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  } catch { alert("Could not copy link."); }
});
downloadBtn?.addEventListener("click", () => {
  try {
    const url=qrcodeCanvas.toDataURL("image/png");
    const a=document.createElement("a");
    a.href=url; a.download="qr-link.png";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } catch { alert("Could not download QR."); }
});

// Pro modal
getProBtn?.addEventListener("click",(e)=>{e.preventDefault();openModal(proModal);});
closeProModal?.addEventListener("click",()=>closeModal(proModal));
proModal?.addEventListener("click",(e)=>{if(e.target&&e.target.matches(".modal-overlay,[data-close='modal']"))closeModal(proModal);});

// Checkout polling
document.querySelectorAll(".plan-select").forEach((btn)=>{
  btn.addEventListener("click", async (e)=>{
    e.preventDefault();
    const tier = Number(btn.dataset.tier||0);
    if(!tier) return;
    await window.openCheckout?.(tier);
    closeModal(proModal);
    tokenInput?.focus();
  });
});

window.openCheckout = async function (tier) {
  try {
    const r = await fetch("/api/checkout-session",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({tier})
    });
    if(!r.ok) throw new Error(await r.text());
    const { session_id } = await r.json();
    startStatusPolling(session_id);
  } catch(e){
    alert("Could not start checkout session.");
    console.error(e);
  }
};

function startStatusPolling(sessionId){
  stopStatusPolling();
  statusPollTimer=setInterval(async()=>{
    try{
      const r=await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`);
      if(!r.ok) return;
      const data=await r.json();
      if(data?.ready&&data?.token){
        stopStatusPolling();
        showSuccessModal(data.token,sessionId);
      }
    }catch{}
  },2000);
}
function stopStatusPolling(){ if(statusPollTimer){ clearInterval(statusPollTimer); statusPollTimer=null; } }

// Success modal
function openSuccess(m){ if(!m) return; m.classList.add("open"); m.setAttribute("aria-hidden","false"); document.addEventListener("keydown", onEsc); document.addEventListener("keydown", trapTab); }
function closeSuccess(){ closeModal(successModal); }
function showSuccessModal(token,sessionId){
  successTokenEl.textContent=token;
  try{ localStorage.setItem("pro_token",token);}catch{}
  if(resendLink){
    const subject=encodeURIComponent("QR Expiry Links - Resend my code");
    const body=encodeURIComponent(`Hello,\nI completed the payment. My sessionId is: ${sessionId}\nPlease resend my Pro code.`);
    resendLink.href=`mailto:support@example.com?subject=${subject}&body=${body}`;
  }
  openSuccess(successModal);
}
successCopyBtn?.addEventListener("click", async ()=>{ try{ const t=successTokenEl?.textContent||""; if(!t) return; await navigator.clipboard.writeText(t); successCopyBtn.textContent="Copied!"; setTimeout(()=>successCopyBtn.textContent="Copy",1200);}catch{} });
successApplyBtn?.addEventListener("click", ()=>{ const t=successTokenEl?.textContent||""; if(!t) return; tokenInput.value=t; closeSuccess(); tokenInput.focus(); });
closeSuccessModal?.addEventListener("click", closeSuccess);
successModal?.addEventListener("click",(e)=>{ if(e.target&&e.target.matches(".modal-overlay,[data-close='success']")) closeSuccess(); });

// Prefill saved pro token
try{ const saved=localStorage.getItem("pro_token"); if(saved&&tokenInput&&!tokenInput.value) tokenInput.value=saved; }catch{}
