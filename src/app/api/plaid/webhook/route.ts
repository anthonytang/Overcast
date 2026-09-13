import { NextResponse } from "next/server";
import { syncPlaidItem } from "@/lib/plaid/sync";
import { verifyPlaidWebhook } from "@/lib/plaid/verify-webhook";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** Receives verified transaction updates and replays the cursor-based sync. */
export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    await verifyPlaidWebhook(rawBody, request.headers.get("plaid-verification"));
    const payload = JSON.parse(rawBody) as { webhook_type?: string; webhook_code?: string; item_id?: string };
    if (payload.webhook_type !== "TRANSACTIONS" || !payload.item_id) return NextResponse.json({ received: true });
    if (!["SYNC_UPDATES_AVAILABLE", "RECURRING_TRANSACTIONS_UPDATE"].includes(payload.webhook_code ?? "")) return NextResponse.json({ received: true });
    const db = createSupabaseAdminClient();
    const { data: item, error } = await db.from("bank_items")
      .select("id,user_id,plaid_item_id,access_token_encrypted,sync_cursor")
      .eq("plaid_item_id", payload.item_id).single();
    if (error || !item) return NextResponse.json({ received: true });
    await syncPlaidItem(item);
    return NextResponse.json({ received: true, synced: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
