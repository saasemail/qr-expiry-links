// api/r2-get.js
// Redirects to a presigned GET URL (download/preview) so big files stream from R2 directly.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const R2_ENDPOINT = mustEnv("R2_ENDPOINT");
const R2_BUCKET = mustEnv("R2_BUCKET");
const R2_ACCESS_KEY_ID = mustEnv("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = mustEnv("R2_SECRET_ACCESS_KEY");

const GET_EXPIRES_SECONDS = 60 * 15; // 15 min

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

function isSafeKey(key) {
  if (!key) return false;
  if (key.length > 300) return false;
  // only allow our prefixes
  return key.startsWith("files/") || key.startsWith("texts/");
}

export default async function handler(req, res) {
  try {
    const { key, name, ct, inline } = req.query || {};
    if (!isSafeKey(key)) {
      res.status(400).send("Invalid key");
      return;
    }

    const fileName = typeof name === "string" ? name.slice(0, 180) : "";
    const contentType = typeof ct === "string" ? ct.slice(0, 120) : "";

    const cmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ...(contentType ? { ResponseContentType: contentType } : {}),
      ...(fileName
        ? {
            ResponseContentDisposition:
              (inline === "1" ? "inline" : "attachment") + `; filename="${fileName.replace(/"/g, "")}"`
          }
        : {})
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: GET_EXPIRES_SECONDS });

    res.statusCode = 302;
    res.setHeader("Location", url);
    res.end();
  } catch (e) {
    res.status(500).send(e?.message || "Server error");
  }
}