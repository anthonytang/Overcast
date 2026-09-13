import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { getTokenEncryptionKey } from "@/lib/server-env";

/** Encrypt Plaid access tokens before persistence using AES-256-GCM. */
export function encryptAccessToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((value) => value.toString("base64url")).join(".");
}

export function decryptAccessToken(encoded: string): string {
  const [ivText, tagText, ciphertextText] = encoded.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted access token");
  const decipher = createDecipheriv("aes-256-gcm", getTokenEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
