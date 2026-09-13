import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { syncPlaidItem } from "@/lib/plaid/sync";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";
// Plaid item IDs are opaque identifiers (for example, `item_abc…`), not UUIDs.
const bodySchema = z.object({ itemId: z.string().min(1).max(256).optional() }).optional();

/** Explicit, authenticated sync for first-load and a user-requested refresh. */
export async function POST(request: NextRequest) {
  try {
    const user = await resolveBankUser(request);
    const body = await request.json().catch(() => undefined);
    const itemId = bodySchema.parse(body)?.itemId ?? request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });
    const db = createSupabaseAdminClient();
    const { data: item, error } = await db.from("bank_items")
      .select("id,user_id,plaid_item_id,access_token_encrypted,sync_cursor")
      .eq("plaid_item_id", itemId)
      .eq("user_id", user.id)
      .single();
    if (error || !item) return NextResponse.json({ error: "Connected bank not found" }, { status: 404 });
    return NextResponse.json(await syncPlaidItem(item));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not synchronize transactions";
    return NextResponse.json({ error: message }, { status: message === "Authentication required" || message === "Invalid session" ? 401 : 400 });
  }
}
