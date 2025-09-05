// ui.js — Auth (email/password + forgot/reset via Supabase), Pro gating, checkout polling, create flow

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL =
  window.NEXT_PUBLIC_SUPABASE_URL ||
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_URL) ||
  "https://xyfacudywygreaquvzjr.supabase.co";

const SUPABASE_ANON_KEY =
  window.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

// PKCE + ručno procesiranje URL-a
const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: "pkce",
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false, // sami obrađujemo URL
  },
});

// Inputs / buttons
const urlInput = document.getElementById("urlInput");
const expiryInput = document.getElementById("expiryInput");
const tokenInput = document.getElementById("tokenInput");
const generateBtn = document.getElementById("generateBtn");

// Result
const resultCard = document.getElementById("resultCard");
const qrcodeCanvas = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint = document.getElementById("expiryHint");
const countdownEl = document.getElementById("countdown");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

// Navbar auth
const userBadge = document.getElementById("userBadge");
const authOpenBtn = document.getElementById("authOpenBtn");
const signOutBtn = document.getElementById("signOutBtn");

// Pro modal
const proModal = document.getElementById("proModal");
const getProBtn = document.getElementById("getProBtn");
const closeProModal = document.getElementById("closeProModal");
const proGateHint = document.getElementById("proGateHint");

// Success modal
const successModal = document.getElementById("successModal");
const closeSuccessModal = document.getElementById("closeSuccessModal");
const successTokenEl = document.getElementById("successToken");
const successCopyBtn = document.getElementById("successCopyBtn");
const successApplyBtn = document.getElementById("successApplyBtn");
const resendLink = document.getElementById("resendLink");

// Auth modal (email/password)
const authModal = document.getElementById("authModal");
const closeAuthModal = document.getElementById("closeAuthModal");
const tabLogin = document.getElementById("tabLogin");
const tabSignup = document.getElementById("tabSignup");
const authLogin = document.getElementById("authLogin");
const authSignup = document.getElementById("authSignup");

const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginSubmit = document.getElementById("loginSubmit");
const loginHint = document.getElementById("loginHint");

const signupEmail = document.getElementById("signupEmail");
const signupPassword = document.getElementById("signupPassword");
const signupSubmit = document.getElementById("signupSubmit");
const signupHint = document.getElementById("signupHint");

// Reset modal
const resetModal = document.getElementById("resetModal");
const closeResetModal = document.getElementById("closeResetModal");
const resetPassword = document.getElementById("resetPassword");
const resetPassword2 = document.getElementById("resetPassword2");
const resetSubmit = document.getElementById("resetSubmit");
const resetHint = document.getElementById("resetHint");
const forgotPwdLink = document.getElementById("forgotPwdLink");

let expiryTimer;
let countdownTimer;
let lastRedirectUrl = "";
let statusPollTimer = null;

// ---- Auth UI ----
async function refreshAuthUI() {
  const { data: { session } } = await supa.auth.getSession();
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

// Catch auth state changes (incl. PASSWORD_RECOVERY)
supa.auth.onAuthStateChange(async (event) => {
  if (event === "PASSWORD_RECOVERY") openModal(resetModal);
  await refreshAuthUI();
});

// --- Obradi auth redirect i na index strani (ako link nekad sleti ovde)
(async function maybeHandleAuthOnIndex() {
  try {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const hash = url.hash || "";

    const type = params.get("type") || (hash.includes("type=recovery") ? "recovery" : null);
    const codeInQuery = params.get("code");
    const hasHashTokens = /access_token=/.test(hash) && /refresh_token=/.test(hash);

    if (codeInQuery) {
      const { error } = await supa.auth.exchangeCodeForSession(window.location.href);
      if (error) throw error;
      history.replaceState(null, "", location.origin + location.pathname);
      if (type === "recovery") openModal(resetModal);
      await refreshAuthUI();
    } else if (hasHashTokens) {
      const at = hash.match(/access_token=([^&]+)/)?.[1];
      const rt = hash.match(/refresh_token=([^&]+)/)?.[1];
      if (at && rt) {
        await supa.auth.setSession({
          access_token: decodeURIComponent(at),
          refresh_token: decodeURIComponent(rt),
        });
      }
      history.replaceState(null, "", location.origin + location.pathname);
      if (type === "recovery") openModal(resetModal);
      await refreshAuthUI();
    }
  } catch (e) {
    console.warn("[index auth redirect]", e?.message || e);
  }
})();

// ---- Auth modal open/close & tabs ----
function openModal(modal) {
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const first = modal.querySelector(".modal-close, button, a, input");
  (first || modal.querySelector(".modal-card"))?.focus();
  document.addEventListener("keydown", onEsc);
  document.addEventListener("keydown", trapTab);
}
function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onEsc);
  document.removeEventListener("keydown", trapTab);
}
function onEsc(e) {
  if (e.key === "Escape") {
    closeModal(proModal);
    closeModal(successModal);
    closeModal(authModal);
    closeModal(resetModal);
  }
}
function trapTab(e) {
  const open = document.querySelector(".modal.open");
  if (!open || e.key !== "Tab") return;
  const f = open.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

authOpenBtn?.addEventListener("click", (e) => { e.preventDefault(); openModal(authModal); });
closeAuthModal?.addEventListener("click", () => closeModal(authModal));
authModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='auth']")) closeModal(authModal);
});

tabLogin?.addEventListener("click", () => setAuthTab("login"));
tabSignup?.addEventListener("click", () => setAuthTab("signup"));
function setAuthTab(which) {
  const login = which === "login";
  authLogin.style.display = login ? "" : "none";
  authSignup.style.display = login ? "none" : "";
  tabLogin.setAttribute("aria-selected", login ? "true" : "false");
  tabSignup.setAttribute("aria-selected", !login ? "true" : "false");
}

// ---- Auth actions (email/password) ----
loginSubmit?.addEventListener("click", async () => {
  loginHint.textContent = "";
  loginSubmit.disabled = true;
  const prevTxt = loginSubmit.textContent;
  loginSubmit.textContent = "Logging in…";
  try {
    const email = loginEmail.value.trim();
    const password = loginPassword.value;
    if (!email || !password) {
      loginHint.textContent = "Enter email and password.";
      return;
    }
    const { error } = await supa.auth.signInWithPassword({ email, password });
    if (error) {
      loginHint.textContent = error.message || "Login failed.";
      return;
    }
    closeModal(authModal);
    await refreshAuthUI();
  } catch (e) {
    loginHint.textContent = e?.message || "Login failed.";
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = prevTxt;
  }
});

signupSubmit?.addEventListener("click", async () => {
  signupHint.textContent = "";
  try {
    const email = signupEmail.value.trim();
    const password = signupPassword.value;
    if (!email || !password) {
      signupHint.textContent = "Enter email and password.";
      return;
    }
    const { data, error } = await supa.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth.html` },
    });
    if (error) {
      signupHint.textContent = error.message || "Sign up failed.";
      return;
    }
    if (data?.user && !data?.session) {
      signupHint.textContent = "Check your inbox to confirm the email, then log in.";
    } else {
      closeModal(authModal);
      await refreshAuthUI();
    }
  } catch (e) {
    signupHint.textContent = e?.message || "Sign up failed.";
  }
});

signOutBtn?.addEventListener("click", async () => {
  await supa.auth.signOut();
  await refreshAuthUI();
});

// ---- Forgot password ----
forgotPwdLink?.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = prompt("Enter your account email:");
  if (!email) return;
  const { error } = await supa.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth.html?type=recovery`,
  });
  if (error) {
    alert("Failed to send reset email: " + (error.message || "Unknown error"));
  } else {
    alert("Check your inbox for the reset link.");
  }
});

// ---- Reset password modal ----
closeResetModal?.addEventListener("click", () => closeModal(resetModal));
resetModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='reset']")) closeModal(resetModal);
});

resetSubmit?.addEventListener("click", async () => {
  resetHint.textContent = "";
  const p1 = resetPassword.value;
  const p2 = resetPassword2.value;
  if (!p1 || !p2) {
    resetHint.textContent = "Enter and repeat the new password.";
    return;
  }
  if (p1 !== p2) {
    resetHint.textContent = "Passwords do not match.";
    return;
  }
  if (p1.length < 6) {
    resetHint.textContent = "Password must be at least 6 characters.";
    return;
  }
  try {
    const { error } = await supa.auth.updateUser({ password: p1 });
    if (error) {
      resetHint.textContent = error.message || "Could not update password.";
      return;
    }
    resetHint.textContent = "Password updated. You can now log in.";
    setTimeout(() => {
      closeModal(resetModal);
      openModal(authModal);
      setAuthTab("login");
    }, 700);
  } catch (e) {
    resetHint.textContent = e?.message || "Could not update password.";
  }
});

// ---- Helpers ----
function setLoading(state) {
  generateBtn.disabled = state;
  generateBtn.textContent = state ? "Generating..." : "Generate QR";
}

async function getAccessToken() {
  const { data: { session } } = await supa.auth.getSession();
  return session?.access_token || null;
}

async function createLink(url, minutes, token) {
  const headers = { "Content-Type": "application/json" };
  const jwt = await getAccessToken();
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const resp = await fetch("/api/create", {
    method: "POST",
    headers,
    body: JSON.stringify({ url, minutes, token }),
  });

  if (!resp.ok) {
    if (resp.status === 401) {
      proGateHint.style.display = "";
      throw new Error("Login required for Pro features.");
    }
    if (resp.status === 429) {
      const msg = await resp.text();
      throw new Error(msg || "Daily limit reached.");
    }
    const text = await resp.text();
    try {
      const maybe = JSON.parse(text);
      throw new Error(maybe?.message || text || "Create failed");
    } catch {
      throw new Error(text || "Create failed");
    }
  }

  return resp.json();
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function startCountdown(isoExpires) {
  const end = new Date(isoExpires).getTime();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      countdownEl.textContent = "Expired";
      const ctx = qrcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
      return;
    }
    countdownEl.textContent = formatCountdown(left);
  }, 1000);
}

// ---- Generate flow ----
generateBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const minutes = parseInt(expiryInput.value, 10);
  const token = (tokenInput?.value || "").trim();

  if (!/^https?:\/\//i.test(url)) {
    alert("Please enter a valid URL (include https://).");
    return;
  }
  if (!Number.isFinite(minutes) || minutes < 1) {
    alert("Expiry must be at least 1 minute.");
    return;
  }

  // Optional pre-gate for Pro
  const proIntent = minutes > 60 || !!token;
  const { data: { session } } = await supa.auth.getSession();
  if (proIntent && !session) {
    proGateHint.style.display = "";
    openModal(authModal);
    return;
  }

  clearTimeout(expiryTimer);
  clearInterval(countdownTimer);
  setLoading(true);

  try {
    const created = await createLink(url, minutes, token);
    const linkId = created.id;
    const redirectUrl = `${window.location.origin}/go/${linkId}`;
    lastRedirectUrl = redirectUrl;

    generatedLink.textContent = redirectUrl;
    generatedLink.href = redirectUrl;

    QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 200 }, (err) => {
      if (err) console.error(err);
    });

    resultCard.classList.remove("hidden");
    const endLocal = new Date(created.expires_at);
    expiryHint.textContent = `Plan: ${(created.plan || "free").toUpperCase()} • Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

    expiryTimer = setTimeout(() => {
      const ctx = qrcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
      countdownEl.textContent = "Expired";
    }, created.minutes * 60_000);

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
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy link"), 1200);
    } else {
      const ta = document.createElement("textarea");
      ta.value = lastRedirectUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  } catch {
    alert("Could not copy link.");
  }
});

downloadBtn?.addEventListener("click", () => {
  try {
    const url = qrcodeCanvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "qr-link.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    alert("Could not download QR.");
  }
});

// ---- Pro modal open/close ----
getProBtn?.addEventListener("click", (e) => { e.preventDefault(); openModal(proModal); });
closeProModal?.addEventListener("click", () => closeModal(proModal));
proModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='modal']")) closeModal(proModal);
});

// Plan selection -> checkout session + polling
document.querySelectorAll(".plan-select").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const tier = Number(btn.dataset.tier || 0);
    if (!tier) return;
    await window.openCheckout?.(tier);
    closeModal(proModal);
    tokenInput?.focus();
  });
});

// ---- Partner checkout hook ----
window.openCheckout = async function (tier) {
  try {
    const r = await fetch("/api/checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier })
    });
    if (!r.ok) throw new Error(await r.text());
    const { session_id } = await r.json();
    startStatusPolling(session_id);
  } catch (e) {
    alert("Could not start checkout session.");
    console.error(e);
  }
};

function startStatusPolling(sessionId) {
  stopStatusPolling();
  statusPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data?.ready && data?.token) {
        stopStatusPolling();
        showSuccessModal(data.token, sessionId);
      }
    } catch {}
  }, 2000);
}
function stopStatusPolling() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

// ---- Success modal ----
function openSuccess(modal) {
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const first = modal.querySelector(".modal-close, button, a, input");
  (first || modal.querySelector(".modal-card"))?.focus();
  document.addEventListener("keydown", onEsc);
  document.addEventListener("keydown", trapTab);
}
function closeSuccess() { closeModal(successModal); }

function showSuccessModal(token, sessionId) {
  successTokenEl.textContent = token;
  try { localStorage.setItem("pro_token", token); } catch {}
  if (resendLink) {
    const subject = encodeURIComponent("QR Expiry Links - Resend my code");
    const body = encodeURIComponent(`Hello,\nI completed the payment. My sessionId is: ${sessionId}\nPlease resend my Pro code.`);
    resendLink.href = `mailto:support@example.com?subject=${subject}&body=${body}`;
  }
  openSuccess(successModal);
}

successCopyBtn?.addEventListener("click", async () => {
  try {
    const t = successTokenEl?.textContent || "";
    if (!t) return;
    await navigator.clipboard.writeText(t);
    successCopyBtn.textContent = "Copied!";
    setTimeout(() => (successCopyBtn.textContent = "Copy"), 1200);
  } catch {}
});
successApplyBtn?.addEventListener("click", () => {
  const t = successTokenEl?.textContent || "";
  if (!t) return;
  tokenInput.value = t;
  closeSuccess();
  tokenInput.focus();
});
closeSuccessModal?.addEventListener("click", closeSuccess);
successModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='success']")) closeSuccess();
});

// Prefill saved pro token
try {
  const saved = localStorage.getItem("pro_token");
  if (saved && tokenInput && !tokenInput.value) tokenInput.value = saved;
} catch {}

// Initial auth render
refreshAuthUI();
