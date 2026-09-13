import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/server-env";

/** A non-sensitive deployment readiness check; it intentionally reveals no keys. */
export async function GET() {
  const env = getServerEnv();
  return NextResponse.json({
    status: "ready",
    integrations: {
      plaid: Boolean(env.plaidClientId && env.plaidSecret),
      supabase: Boolean(env.supabaseUrl && env.supabaseSecretKey && env.databaseUrl),
      aiDrafting: Boolean(env.geminiApiKey),
    },
  });
}
