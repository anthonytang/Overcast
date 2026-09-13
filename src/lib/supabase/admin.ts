import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/server-env";

/**
 * Privileged client for trusted Route Handlers and background workers only.
 * Never import this from a Client Component: its key bypasses Row Level
 * Security and must never reach a browser bundle.
 */
export function createSupabaseAdminClient() {
  const env = getServerEnv();
  return createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
