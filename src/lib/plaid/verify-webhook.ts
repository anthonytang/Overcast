import "server-only";

import { createHash, timingSafeEqual } from "crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { createPlaidClient } from "@/lib/plaid/client";

/** Verifies Plaid's ES256 signature, freshness, and exact raw-body hash. */
export async function verifyPlaidWebhook(rawBody: string, signature: string | null) {
  if (!signature) throw new Error("Missing Plaid-Verification header");
  const header = decodeProtectedHeader(signature);
  if (header.alg !== "ES256" || typeof header.kid !== "string") throw new Error("Invalid Plaid webhook signature");
  const keyResponse = await createPlaidClient().webhookVerificationKeyGet({ key_id: header.kid });
  const key = await importJWK(keyResponse.data.key as JWK, "ES256");
  const { payload } = await jwtVerify(signature, key, { algorithms: ["ES256"] });
  if (!payload.iat || Math.abs(Date.now() / 1000 - payload.iat) > 300) throw new Error("Expired Plaid webhook");
  const expected = String(payload.request_body_sha256 ?? "");
  const actual = createHash("sha256").update(rawBody).digest("hex");
  if (expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new Error("Plaid webhook body hash mismatch");
}
