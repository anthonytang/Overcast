import { NextResponse } from "next/server";
import { Products } from "plaid";
import { createPlaidClient } from "@/lib/plaid/client";
import { syncPlaidItem } from "@/lib/plaid/sync";
import { encryptAccessToken } from "@/lib/security/token-crypto";
import { getServerEnv } from "@/lib/server-env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";

function isoDay(daysAgo: number) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - daysAgo);
  return day.toISOString().slice(0, 10);
}

/** A bounded, purpose-built Sandbox ledger. It creates a new Item and leaves
 * the prior connected Item intact. The history is clearly for demo rehearsal,
 * not a representation of a real person or a production financial profile. */
function engineeredLedger() {
  const transactions: Array<{ date_transacted: string; date_posted: string; amount: number; description: string }> = [];
  const add = (daysAgo: number, amount: number, description: string) => {
    const date = isoDay(daysAgo);
    transactions.push({ date_transacted: date, date_posted: date, amount, description });
  };
  for (let daysAgo = 179; daysAgo >= 0; daysAgo -= 1) {
    if (daysAgo % 14 === 7) add(daysAgo, -1450, "NORTHSTAR PAYROLL");
    if (daysAgo % 30 === 28) add(daysAgo, 1120, "HARBOR RENT");
    if (daysAgo % 30 === 15) add(daysAgo, 148, "CITY ELECTRIC");
    if (daysAgo % 30 === 11) add(daysAgo, 16.99, "STREAMFLIX");
    if (daysAgo % 2 === 0) add(daysAgo, 34 + (daysAgo % 5) * 6, "FRESH MART");
    if (daysAgo % 4 === 1) add(daysAgo, 5.5 + (daysAgo % 3) * 1.25, "NEIGHBORHOOD COFFEE");
    if (daysAgo % 7 === 5) add(daysAgo, 18 + (daysAgo % 4) * 4, "CITY TRANSIT");
  }
  return transactions;
}

export async function POST(request: Request) {
  try {
    if (process.env.PLAID_ENV === "production") {
      return NextResponse.json({ error: "Engineered accounts are available only in Sandbox" }, { status: 403 });
    }
    const user = await resolveBankUser(request);
    const plaid = createPlaidClient();
    const env = getServerEnv();
    const created = await plaid.sandboxPublicTokenCreate({
      // Plaid permits credentials in headers or the request body. Supplying
      // them explicitly here avoids a client-library edge case specific to
      // this Sandbox-only endpoint; they never leave this server route.
      client_id: env.plaidClientId,
      secret: env.plaidSecret,
      institution_id: "ins_109508",
      initial_products: [Products.Transactions],
      options: {
        override_username: "user_custom",
        override_password: JSON.stringify({
          seed: "overcast-engineered-demo-v1",
          override_accounts: [
            {
              type: "depository",
              subtype: "checking",
              // Enough cushion for ordinary day-one variation, but not for
              // rent clearing five days before payroll. This makes the demo
              // optimizer's least-painful timing fix observable.
              starting_balance: 180,
              transactions: engineeredLedger(),
            },
            {
              type: "depository",
              subtype: "savings",
              starting_balance: 850,
            },
          ],
        }),
        transactions: { days_requested: 180 },
        ...(process.env.PLAID_WEBHOOK_URL ? { webhook: process.env.PLAID_WEBHOOK_URL } : {}),
      },
    });
    const exchange = await plaid.itemPublicTokenExchange({ public_token: created.data.public_token });
    const db = createSupabaseAdminClient();
    const { error: saveError } = await db.from("bank_items").upsert({
      user_id: user.id,
      plaid_item_id: exchange.data.item_id,
      access_token_encrypted: encryptAccessToken(exchange.data.access_token),
      institution_name: "First Platypus Bank: engineered demo",
      status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "plaid_item_id" });
    if (saveError) throw new Error(`Could not save engineered Sandbox account: ${saveError.message}`);
    const { data: item, error: itemError } = await db.from("bank_items")
      .select("id,user_id,plaid_item_id,access_token_encrypted,sync_cursor")
      .eq("plaid_item_id", exchange.data.item_id)
      .single();
    if (itemError || !item) throw new Error("Could not load engineered Sandbox account");
    // A new Sandbox Item can acknowledge its first cursor page before the
    // custom ledger is available. Retry only that empty first pull so the
    // button reliably lands on a populated demo instead of a blank dashboard.
    let sync = await syncPlaidItem(item);
    if (sync.added === 0 && sync.pages > 0) {
      const { data: refreshedItem } = await db.from("bank_items")
        .select("id,user_id,plaid_item_id,access_token_encrypted,sync_cursor")
        .eq("id", item.id).maybeSingle();
      if (refreshedItem) sync = await syncPlaidItem(refreshedItem);
    }
    const response = NextResponse.json({ itemId: exchange.data.item_id, transactionCount: sync.added });
    response.cookies.set("overcast_sandbox_item", exchange.data.item_id, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24,
    });
    return response;
  } catch (error) {
    const plaidError = typeof error === "object" && error !== null && "response" in error
      ? (error as { response?: { data?: { error_code?: string; error_message?: string } } }).response?.data
      : undefined;
    const message = plaidError?.error_message
      ? `${plaidError.error_code ?? "PLAID_ERROR"}: ${plaidError.error_message}`
      : error instanceof Error ? error.message : "Could not create engineered Sandbox account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
