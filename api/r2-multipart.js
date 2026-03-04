// api/r2-multipart.js
// Multipart upload (start -> sign parts -> complete) for faster & more reliable large uploads.

import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const R2_ENDPOINT = mustEnv("R2_ENDPOINT");
const R2_BUCKET = mustEnv("R2_BUCKET");
const R2_ACCESS_KEY_ID = mustEnv("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = mustEnv("R2_SECRET_ACCESS_KEY");

const FILES_MAX_BYTES = Number(process.env.FILES_MAX_BYTES || "524288000"); // 500MB
const SIGN_EXPIRES_SECONDS = 60 * 10;

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

function makeKey({ filename, folder }) {
  const ext = safeName(filename).split(".").pop();
  const baseFolder = String(folder || "files").toLowerCase();
  const safeFolder = (baseFolder === "files" || baseFolder === "texts") ? baseFolder : "files";
  return `${safeFolder}/${Date.now()}_${crypto.randomBytes(16).toString("hex")}.${(ext || "bin").slice(0, 10)}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = req.body || {};
    const action = String(body.action || "");

    // Basic validation for size (when present)
    if (body.size != null) {
      const fileSize = Number(body.size || 0);
      if (!fileSize || !Number.isFinite(fileSize) || fileSize <= 0) {
        res.status(400).json({ error: "Missing/invalid size" });
        return;
      }
      if (fileSize > FILES_MAX_BYTES) {
        res.status(413).json({ error: `File too large. Max ${FILES_MAX_BYTES} bytes.` });
        return;
      }
    }

    if (action === "start") {
      const { filename, contentType, folder } = body;
      const key = makeKey({ filename, folder });
      const ct = String(contentType || "application/octet-stream").slice(0, 120);

      const cmd = new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: ct
      });

      const out = await s3.send(cmd);

      res.status(200).json({
        key,
        uploadId: out.UploadId,
        expiresIn: SIGN_EXPIRES_SECONDS
      });
      return;
    }

    if (action === "sign") {
      const { key, uploadId, partNumber } = body;
      const pn = Number(partNumber);

      if (!key || !uploadId || !pn || pn < 1) {
        res.status(400).json({ error: "Missing key/uploadId/partNumber" });
        return;
      }

      const cmd = new UploadPartCommand({
        Bucket: R2_BUCKET,
        Key: String(key),
        UploadId: String(uploadId),
        PartNumber: pn
      });

      const url = await getSignedUrl(s3, cmd, { expiresIn: SIGN_EXPIRES_SECONDS });
      res.status(200).json({ url });
      return;
    }

    if (action === "complete") {
      const { key, uploadId, parts } = body;

      if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
        res.status(400).json({ error: "Missing key/uploadId/parts" });
        return;
      }

      // Must be sorted by PartNumber
      const cleaned = parts
        .map(p => ({
          ETag: String(p.ETag || "").replace(/^"+|"+$/g, ""),
          PartNumber: Number(p.PartNumber)
        }))
        .filter(p => p.ETag && p.PartNumber);

      cleaned.sort((a, b) => a.PartNumber - b.PartNumber);

      const cmd = new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: String(key),
        UploadId: String(uploadId),
        MultipartUpload: { Parts: cleaned.map(p => ({ ETag: p.ETag, PartNumber: p.PartNumber })) }
      });

      await s3.send(cmd);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "abort") {
      const { key, uploadId } = body;
      if (!key || !uploadId) {
        res.status(400).json({ error: "Missing key/uploadId" });
        return;
      }

      const cmd = new AbortMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: String(key),
        UploadId: String(uploadId)
      });

      await s3.send(cmd);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Server error" });
  }
}