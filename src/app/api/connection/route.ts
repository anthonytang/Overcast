import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** Browser-visible state only; the connected Plaid item identifier stays HttpOnly. */
export async function GET(request: NextRequest) {
  const itemId = request.cookies.get("overcast_sandbox_item")?.value;
  if (!itemId) {
    return NextResponse.json({ connected: false, webhookConfigured: Boolean(process.env.PLAID_WEBHOOK_URL) });
  }

  const { data } = await createSupabaseAdminClient()
    .from("bank_items")
    .select("updated_at,status")
    .eq("plaid_item_id", itemId)
    .maybeSingle();

  return NextResponse.json({
    connected: data?.status === "active",
    lastSyncedAt: data?.updated_at ?? null,
    webhookConfigured: Boolean(process.env.PLAID_WEBHOOK_URL),
  });
}
