// api/r2-upload-url.js
// Returns a presigned PUT URL so the browser can upload directly to R2 (supports large files).
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const R2_ACCOUNT_ID = mustEnv("R2_ACCOUNT_ID");
const R2_ENDPOINT = mustEnv("R2_ENDPOINT"); // e.g. https://<accountid>.r2.cloudflarestorage.com
const R2_BUCKET = mustEnv("R2_BUCKET");
const R2_ACCESS_KEY_ID = mustEnv("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = mustEnv("R2_SECRET_ACCESS_KEY");

const FILES_MAX_BYTES = Number(process.env.FILES_MAX_BYTES || "524288000"); // default 500MB
const PUT_EXPIRES_SECONDS = 60 * 10; // 10 min to start/upload

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

function safeName(name) {
  const n = String(name || "file").slice(0, 120);
  return n.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { filename, contentType, size, folder } = req.body || {};
    const fileSize = Number(size || 0);
    if (!fileSize || !Number.isFinite(fileSize) || fileSize <= 0) {
      res.status(400).json({ error: "Missing/invalid size" });
      return;
    }
    if (fileSize > FILES_MAX_BYTES) {
      res.status(413).json({ error: `File too large. Max ${FILES_MAX_BYTES} bytes.` });
      return;
    }

    const ext = safeName(filename).split(".").pop();
    const baseFolder = String(folder || "files").toLowerCase();
    const safeFolder = (baseFolder === "files" || baseFolder === "texts") ? baseFolder : "files";

    const key = `${safeFolder}/${Date.now()}_${crypto.randomBytes(16).toString("hex")}.${(ext || "bin").slice(0, 10)}`;

    const ct = String(contentType || "application/octet-stream").slice(0, 120);

    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: ct,
      // Private bucket, so no ACL needed (R2 ignores some ACLs anyway)
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: PUT_EXPIRES_SECONDS });

    res.status(200).json({
      key,
      uploadUrl,
      expiresIn: PUT_EXPIRES_SECONDS
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Server error" });
  }
}