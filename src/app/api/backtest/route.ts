import { NextRequest, NextResponse } from "next/server";
import { backtestForecast, type BacktestResult } from "@/lib/backtest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

async function currentAccount(request: NextRequest) {
  const plaidItemId = request.cookies.get("overcast_sandbox_item")?.value;
  if (!plaidItemId) return null;
  const user = await resolveBankUser(request);
  const db = createSupabaseAdminClient();
  const { data: item } = await db.from("bank_items").select("id").eq("user_id", user.id).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (!item) return null;
  const { data: accounts } = await db.from("bank_accounts")
    .select("id,available_balance,current_balance,account_type").eq("bank_item_id", item.id);
  const account = accounts?.find((candidate) => candidate.account_type === "depository") ?? accounts?.[0];
  return account ? { user, account } : null;
}

export async function GET(request: NextRequest) {
  try {
    const connected = await currentAccount(request);
    if (!connected) return NextResponse.json({ result: null });
    const { data } = await createSupabaseAdminClient().from("forecast_runs")
      .select("result,generated_at").eq("account_id", connected.account.id)
      .eq("model_version", "cashflow-bootstrap-backtest-v1").order("generated_at", { ascending: false }).limit(1).maybeSingle();
    return NextResponse.json({ result: (data?.result as BacktestResult | undefined) ?? null, generatedAt: data?.generated_at ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load validation" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const connected = await currentAccount(request);
    if (!connected) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });
    const db = createSupabaseAdminClient();
    const { data: transactions, error } = await db.from("transactions")
      .select("amount,posted_date").eq("account_id", connected.account.id).eq("is_removed", false).eq("pending", false).order("posted_date");
    if (error) throw new Error(`Could not load transaction history: ${error.message}`);
    const balance = Number(connected.account.available_balance ?? connected.account.current_balance ?? 0);
    const result = backtestForecast(balance, (transactions ?? []).map((transaction) => ({ amount: Number(transaction.amount), postedDate: transaction.posted_date })));
    const { error: saveError } = await db.from("forecast_runs").insert({
      user_id: connected.user.id,
      account_id: connected.account.id,
      model_version: result.modelVersion,
      input_version: `transactions:${transactions?.length ?? 0}`,
      horizon_days: result.horizonDays,
      overdraft_probability: result.meanPredictedRisk ?? 0,
      result,
    });
    if (saveError) throw new Error(`Could not save validation run: ${saveError.message}`);
    return NextResponse.json({ result, generatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not run validation" }, { status: 400 });
  }
}
