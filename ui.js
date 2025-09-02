// ui.js - QR Expiry Links

const urlInput = document.getElementById("urlInput");
const expiryInput = document.getElementById("expiryInput");
const generateBtn = document.getElementById("generateBtn");

const resultCard = document.getElementById("resultCard");
const qrcodeCanvas = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint = document.getElementById("expiryHint");

let expiryTimer;

generateBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  const expiryMinutes = parseInt(expiryInput.value);

  if (!url) {
    alert("Please enter a valid URL.");
    return;
  }
  if (!expiryMinutes || expiryMinutes < 1) {
    alert("Expiry must be at least 1 minute.");
    return;
  }

  // Clear previous expiry timer
  clearTimeout(expiryTimer);

  // Show link and QR
  generatedLink.textContent = url;
  generatedLink.href = url;

  QRCode.toCanvas(qrcodeCanvas, url, { width: 200 }, function (error) {
    if (error) console.error(error);
  });

  resultCard.classList.remove("hidden");

  // Expiry handling
  expiryHint.textContent = `This link will expire in ${expiryMinutes} minutes.`;

  expiryTimer = setTimeout(() => {
    qrcodeCanvas.getContext("2d").clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
    generatedLink.textContent = "";
    expiryHint.textContent = "This link has expired.";
  }, expiryMinutes * 60 * 1000);
});
