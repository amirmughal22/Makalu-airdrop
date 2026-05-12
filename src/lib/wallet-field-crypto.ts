import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SALT = "makalu-generated-wallet-v1";

function deriveKey(): Buffer {
  const primary = process.env.AIRDROP_WALLET_STORAGE_SECRET?.trim();
  if (primary && primary.length >= 32) {
    return scryptSync(primary, SALT, 32);
  }
  const auth = process.env.AUTH_SECRET?.trim();
  if (auth && auth.length >= 16) {
    return scryptSync(auth, SALT, 32);
  }
  throw new Error(
    "Wallet encryption requires AIRDROP_WALLET_STORAGE_SECRET (32+ characters recommended) or AUTH_SECRET (min 16 chars).",
  );
}

/** AES-256-GCM; output format: base64(iv || tag || ciphertext). */
export function encryptWalletField(plainUtf8: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plainUtf8, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptWalletField(payloadB64: string): string {
  const key = deriveKey();
  const buf = Buffer.from(payloadB64, "base64");
  if (buf.length < 12 + 16) throw new Error("Invalid encrypted payload");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
