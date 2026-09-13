import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

/**
 * A deliberately narrow ledger endpoint for the Activity screen. It returns
 * only the connected Sandbox item's transactions, never an access token or
 * raw Plaid payload.
 */
export async function GET(request: NextRequest) {
  try {
    const plaidItemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!plaidItemId) return NextResponse.json({ transactions: [] });

    const db = createSupabaseAdminClient();
    const user = await resolveBankUser(request);
    const { data: item } = await db
      .from("bank_items")
      .select("id")
      .eq("user_id", user.id)
      .eq("plaid_item_id", plaidItemId)
      .maybeSingle();
    if (!item) return NextResponse.json({ transactions: [] });

    const { data: accounts, error: accountsError } = await db
      .from("bank_accounts")
      .select("id")
      .eq("bank_item_id", item.id)
      .eq("user_id", user.id);
    if (accountsError) throw accountsError;
    const accountIds = (accounts ?? []).map((account) => account.id);
    if (!accountIds.length) return NextResponse.json({ transactions: [] });

    const { data, error } = await db
      .from("transactions")
      .select("id,posted_date,authorized_date,description,merchant_name,amount,primary_category,detailed_category,pending")
      .in("account_id", accountIds)
      .eq("is_removed", false)
      .order("posted_date", { ascending: false })
      .limit(100);
    if (error) throw error;
    return NextResponse.json({ transactions: data ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load activity";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
