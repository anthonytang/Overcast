import { NextRequest, NextResponse } from "next/server";
import type { ForecastResult } from "@/lib/forecast";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

type StoredRun = { generated_at: string; result: ForecastResult };
type Transaction = { posted_date: string; amount: number | string; description: string; is_removed: boolean };

/** Replays a saved recommendation against transactions that arrived after it
 * was recorded. It remains a counterfactual, not a claim the user took the
 * action, and says "awaiting" until enough observed days exist. */
export async function GET(request: NextRequest) {
  try {
    const runId = request.nextUrl.searchParams.get("runId");
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!runId || !itemId) return NextResponse.json({ error: "A saved decision and connected Sandbox bank are required" }, { status: 400 });
    const user = await resolveBankUser(request);
    const db = createSupabaseAdminClient();
    const { data: item } = await db.from("bank_items").select("id").eq("user_id", user.id).eq("plaid_item_id", itemId).maybeSingle();
    if (!item) return NextResponse.json({ error: "Connected bank was not found" }, { status: 404 });
    const { data: accounts } = await db.from("bank_accounts").select("id,account_type").eq("bank_item_id", item.id);
    const account = accounts?.find((candidate) => candidate.account_type === "depository") ?? accounts?.[0];
    if (!account) return NextResponse.json({ error: "No account is available" }, { status: 404 });
    const { data: run, error: runError } = await db.from("analytics_runs").select("generated_at,result").eq("id", runId).eq("account_id", account.id).maybeSingle();
    if (runError || !run) return NextResponse.json({ error: "Saved decision was not found" }, { status: 404 });
    const stored = run as StoredRun;
    const projection = stored.result;
    const firstDay = projection.series?.[0]?.date;
    if (!firstDay || !projection.decisionPlan?.recommended) return NextResponse.json({ status: "not_replayable", note: "This saved run has no replayable recommendation." });
    const today = new Date().toISOString().slice(0, 10);
    const { data: transactions } = await db.from("transactions").select("posted_date,amount,description,is_removed")
      .eq("account_id", account.id).gte("posted_date", firstDay).lte("posted_date", today).order("posted_date");
    const observed = ((transactions ?? []) as Transaction[]).filter((transaction) => !transaction.is_removed);
    const observedDates = new Set(observed.map((transaction) => transaction.posted_date));
    if (observedDates.size < 3) return NextResponse.json({ status: "awaiting_outcomes", observedDays: observedDates.size, note: "Overcast needs at least three later transaction days to evaluate this saved decision." });
    const netByDate = new Map<string, number>();
    for (const transaction of observed) netByDate.set(transaction.posted_date, (netByDate.get(transaction.posted_date) ?? 0) - Number(transaction.amount));
    const counterfactual = new Map(netByDate);
    const plan = projection.decisionPlan.recommended;
    const planDay = projection.series[Math.max(0, (plan.day ?? 1) - 1)]?.date;
    if ((plan.type === "transfer" || plan.type === "combo") && planDay) counterfactual.set(planDay, (counterfactual.get(planDay) ?? 0) + plan.amount);
    if ((plan.type === "defer" || plan.type === "combo") && plan.streamName && plan.days) {
      const eventDay = projection.series.find((day) => day.events.some((event) => event.name === plan.streamName))?.date;
      if (eventDay) {
        const shifted = new Date(`${eventDay}T00:00:00`); shifted.setDate(shifted.getDate() + plan.days);
        const shiftedDay = shifted.toISOString().slice(0, 10);
        const amount = projection.streams?.find((stream) => stream.name === plan.streamName)?.amount ?? 0;
        counterfactual.set(eventDay, (counterfactual.get(eventDay) ?? 0) + amount);
        counterfactual.set(shiftedDay, (counterfactual.get(shiftedDay) ?? 0) - amount);
      }
    }
    const dates = [...new Set([...netByDate.keys(), ...counterfactual.keys()])].sort();
    let actualBalance = projection.startingBalance;
    let planBalance = projection.startingBalance;
    let actualMin = actualBalance;
    let planMin = planBalance;
    for (const date of dates) {
      actualBalance += netByDate.get(date) ?? 0;
      planBalance += counterfactual.get(date) ?? 0;
      actualMin = Math.min(actualMin, actualBalance);
      planMin = Math.min(planMin, planBalance);
    }
    return NextResponse.json({ status: "ready", observedDays: observedDates.size, actualMinBalance: Math.round(actualMin * 100) / 100, counterfactualMinBalance: Math.round(planMin * 100) / 100, wouldPreventObservedOverdraft: actualMin < 0 && planMin >= 0, note: "This is a transaction-ledger counterfactual. It does not claim the recommendation was actually taken." });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not replay this decision" }, { status: 500 }); }
}
