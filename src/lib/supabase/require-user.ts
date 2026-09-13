import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/lib/server-env";

/** Verifies a bearer token instead of trusting a client-supplied user id. */
export async function requireUser(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) throw new Error("Authentication required");

  const env = getServerEnv();
  const client = createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid session");
  return data.user;
}
