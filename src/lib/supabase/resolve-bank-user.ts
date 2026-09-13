import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * A hackathon Sandbox needs a frictionless demo owner, not a real inbox or
 * production identity flow. Production mode keeps the future-safe guard.
 */
export async function resolveBankUser(request: Request) {
  if (process.env.PLAID_ENV === "production") return requireUser(request);

  const db = createSupabaseAdminClient();
  // Prefer the owner of an already-synced account. This keeps a retry after a
  // failed Link/sync attempt from accidentally switching the demo back to an
  // empty guest record.
  const { data: syncedAccounts } = await db.from("bank_accounts").select("user_id").limit(1);
  const syncedUserId = syncedAccounts?.[0]?.user_id;
  if (syncedUserId) {
    const { data, error } = await db.auth.admin.getUserById(syncedUserId);
    if (!error && data.user) return data.user;
  }

  const email = process.env.SANDBOX_GUEST_EMAIL ?? "overcast-sandbox@local.test";
  const { data: listed, error: listError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw new Error(`Could not access Sandbox owner: ${listError.message}`);
  const existing = listed.users.find((user) => user.email === email);
  if (existing) return existing;

  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`Could not create Sandbox owner: ${error?.message ?? "unknown error"}`);
  return data.user;
}
