import "server-only";

/**
 * Server-only configuration. Keeping validation in one place means a missing
 * financial-data credential fails clearly at startup instead of later in a
 * transaction-sync or forecast request.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

export function getServerEnv() {
  return {
    plaidClientId: required("PLAID_CLIENT_ID"),
    plaidSecret: required("PLAID_SECRET"),
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL"),
    supabasePublishableKey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
    databaseUrl: required("DATABASE_URL"),
    geminiApiKey: process.env.GEMINI_API_KEY,
  };
}

export function getTokenEncryptionKey(): Buffer {
  const raw = required("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}
