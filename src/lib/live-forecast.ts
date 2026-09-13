import "server-only";

import { project, type ForecastResult, type Stream } from "@/lib/forecast";
import { runAnalyticsForecast } from "@/lib/analytics/client";
import { attachRiskModel } from "@/lib/risk-model";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Account = { id: string; name: string; account_type: string; available_balance: number | string | null; current_balance: number | string | null };
type Recurring = { name: string; amount: number | string; cadence_days: number; next_expected_date: string | null; is_income: boolean };
type Transaction = {
  amount: number | string;
  posted_date: string;
  description: string;
  primary_category: string | null;
  detailed_category: string | null;
  pending: boolean;
  is_removed: boolean;
};

function daysUntil(date: string | null, cadence: number, today: Date): number {
  if (!date) return Math.min(cadence, 7);
  const target = new Date(`${date}T00:00:00`);
  if (Number.isNaN(target.getTime())) return Math.min(cadence, 7);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let days = Math.ceil((target.getTime() - start.getTime()) / 86_400_000);
  while (days < 1) days += cadence;
  return days;
}

function historicalVelocity(transactions: Transaction[], today: Date): number {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 59);
  const usable = transactions.filter((transaction) => {
    const posted = new Date(`${transaction.posted_date}T00:00:00`);
    return !transaction.pending && !transaction.is_removed && Number(transaction.amount) > 0 && Number.isFinite(posted.getTime()) && posted >= cutoff && posted <= today;
  });
  if (usable.length === 0) return 0;
  const dates = usable.map((transaction) => new Date(`${transaction.posted_date}T00:00:00`).getTime()).filter(Number.isFinite);
  const earliest = Math.min(...dates);
  const observedDays = Math.max(7, Math.min(60, Math.ceil((today.getTime() - earliest) / 86_400_000) + 1));
  return Math.round((usable.reduce((total, transaction) => total + Number(transaction.amount), 0) / observedDays) * 100) / 100;
}

/**
 * Plaid's recurring endpoint can lag the first transaction sync, especially
 * for a newly-created Sandbox Item. Detect only stable, weekly-or-slower
 * transaction series as a transparent fallback, so income and bills do not
 * get mislabeled as discretionary spending during that gap.
 */
function detectRecurringStreams(transactions: Transaction[], today: Date): Stream[] {
  const grouped = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    if (transaction.pending || transaction.is_removed || !transaction.description) continue;
    const key = transaction.description.trim().toUpperCase();
    grouped.set(key, [...(grouped.get(key) ?? []), transaction]);
  }
  const detected: Stream[] = [];
  for (const [name, entries] of grouped) {
    const dated = entries
      .map((entry) => ({ ...entry, day: new Date(`${entry.posted_date}T00:00:00`) }))
      .filter((entry) => Number.isFinite(entry.day.getTime()))
      .sort((left, right) => left.day.getTime() - right.day.getTime());
    if (dated.length < 3) continue;
    const intervals = dated.slice(1).map((entry, index) => Math.round((entry.day.getTime() - dated[index].day.getTime()) / 86_400_000)).filter((interval) => interval > 0);
    if (intervals.length < 2) continue;
    const sortedIntervals = [...intervals].sort((left, right) => left - right);
    const cadence = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    if (cadence < 7 || cadence > 35 || intervals.some((interval) => Math.abs(interval - cadence) > 2)) continue;
    const amounts = dated.map((entry) => Math.abs(Number(entry.amount))).sort((left, right) => left - right);
    const amount = amounts[Math.floor(amounts.length / 2)];
    const stable = amounts.every((value) => Math.abs(value - amount) <= Math.max(2, amount * 0.08));
    const namedBill = /(PAYROLL|PAYCHECK|RENT|ELECTRIC|UTILITY|INSURANCE|PHONE|SUBSCRIPTION|STREAM)/i.test(name);
    if (!stable && !namedBill) continue;
    const latest = dated.at(-1)!;
    const next = new Date(latest.day);
    do next.setDate(next.getDate() + cadence); while (next <= today);
    detected.push({
      name,
      amount,
      cadenceDays: cadence,
      isIncome: Number(latest.amount) < 0,
      firstDay: Math.max(1, Math.ceil((next.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)),
    });
  }
  return detected;
}

/**
 * Builds the existing deterministic waterline from synced Sandbox data. It
 * prioritizes Plaid's recurring streams and only uses historical daily spend
 * velocity while recurring detection is still unavailable.
 */
export async function runLiveForecast(userId: string, plaidItemId: string): Promise<ForecastResult | null> {
  const db = createSupabaseAdminClient();
  const { data: item, error: itemError } = await db.from("bank_items")
    .select("id,updated_at").eq("user_id", userId).eq("plaid_item_id", plaidItemId).single();
  if (itemError || !item) return null;
  const { data: accounts, error: accountsError } = await db.from("bank_accounts")
    .select("id,name,account_type,available_balance,current_balance")
    .eq("user_id", userId).eq("bank_item_id", item.id);
  if (accountsError) throw new Error(`Could not load bank accounts: ${accountsError.message}`);
  const account = (accounts as Account[] | null)?.find((candidate) => candidate.account_type === "depository") ?? (accounts as Account[] | null)?.[0];
  if (!account) return null;

  const today = new Date();
  const [{ data: recurring, error: recurringError }, { data: transactions, error: transactionsError }] = await Promise.all([
    db.from("recurring_streams").select("name,amount,cadence_days,next_expected_date,is_income").eq("account_id", account.id).eq("active", true),
    db.from("transactions").select("amount,posted_date,description,primary_category,detailed_category,pending,is_removed").eq("account_id", account.id).order("posted_date", { ascending: false }).limit(365),
  ]);
  if (recurringError) throw new Error(`Could not load recurring streams: ${recurringError.message}`);
  if (transactionsError) throw new Error(`Could not load transactions: ${transactionsError.message}`);

  let recurringStreams: Stream[] = ((recurring ?? []) as Recurring[]).map((stream) => ({
    name: stream.name,
    amount: Number(stream.amount),
    cadenceDays: stream.cadence_days,
    isIncome: stream.is_income,
    firstDay: daysUntil(stream.next_expected_date, stream.cadence_days, today),
  }));
  const allTransactions = (transactions ?? []) as Transaction[];
  if (recurringStreams.length === 0) recurringStreams = detectRecurringStreams(allTransactions, today);
  const recurringNames = new Set(recurringStreams.filter((stream) => !stream.isEstimated).map((stream) => stream.name.toLowerCase()));
  const variableSpend = allTransactions
    .filter((transaction) => !transaction.pending && !transaction.is_removed && Number(transaction.amount) > 0)
    .filter((transaction) => !recurringNames.has(transaction.description.toLowerCase()))
    .map((transaction) => ({
      amount: Number(transaction.amount),
      postedDate: transaction.posted_date,
      description: transaction.description,
      primaryCategory: transaction.primary_category,
      detailedCategory: transaction.detailed_category,
    }));
  const velocity = historicalVelocity(variableSpend.map((transaction) => ({ amount: transaction.amount, posted_date: transaction.postedDate, pending: false, is_removed: false, description: "", primary_category: null, detailed_category: null })), today);
  const categoryTotals = new Map<string, number>();
  for (const transaction of variableSpend) {
    const category = transaction.primaryCategory ?? transaction.detailedCategory ?? "Other";
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + transaction.amount);
  }
  const categoryTotal = [...categoryTotals.values()].reduce((sum, amount) => sum + amount, 0);
  const variableSpendingCategories = [...categoryTotals.entries()]
    .map(([name, amount]) => ({ name, share: categoryTotal > 0 ? amount / categoryTotal : 0 }))
    .sort((left, right) => right.share - left.share)
    .slice(0, 4);
  if (velocity > 0) recurringStreams.push({ name: "Typical day-to-day spending", amount: velocity, cadenceDays: 1, isIncome: false, firstDay: 1, isEstimated: true });

  // Forecast from current balance, then let the analytics service settle
  // pending charges/deposits across paths. Available balance is retained for
  // reconciliation and never silently double-counts a pending debit.
  const balance = Number(account.current_balance ?? account.available_balance ?? 0);
  const deterministic = project(recurringStreams, balance, 0, 30, today);
  const savingsAvailable = ((accounts ?? []) as Account[])
    .filter((candidate) => candidate.account_type === "depository" && candidate.id !== account.id)
    .reduce((total, candidate) => total + Math.max(0, Number(candidate.available_balance ?? candidate.current_balance ?? 0)), 0);
  const currentBalance = Number(account.current_balance ?? account.available_balance ?? 0);
  const availableBalance = Number(account.available_balance ?? account.current_balance ?? 0);
  let reservedDebit = Math.max(0, currentBalance - availableBalance);
  const pendingTransactions = allTransactions.filter((transaction) => transaction.pending && !transaction.is_removed).map((transaction) => {
    const originalAmount = Number(transaction.amount);
    const reserved = originalAmount > 0 ? Math.min(originalAmount, reservedDebit) : 0;
    reservedDebit -= reserved;
    return { amount: originalAmount - reserved, authorizedDate: transaction.posted_date, description: transaction.description };
  }).filter((transaction) => transaction.amount !== 0);
  const analytics = await runAnalyticsForecast({
    startingBalance: balance,
    buffer: 0,
    horizonDays: 30,
    startDate: today.toISOString().slice(0, 10),
    streams: recurringStreams,
    transactions: variableSpend,
    savingsAvailable,
    pendingTransactions,
    availableBalance,
    currentBalance,
  });
  const forecast = analytics
    ? {
        ...deterministic,
        series: analytics.series,
        dangerDays: analytics.series.filter((day) => day.isDanger),
        risk: analytics.risk,
        riskSamples: analytics.riskSamples,
        decisionPlan: analytics.optimizer,
        robustness: analytics.robustness,
        waitingPolicy: analytics.waitingPolicy,
        sequentialPolicy: analytics.sequentialPolicy,
        pendingImpact: analytics.pendingImpact,
      }
    : attachRiskModel(deterministic, variableSpend, today);
  return {
    ...forecast,
    source: "plaid" as const,
    accountName: account.name,
    modelNote: analytics
      ? "Calibrated cash-flow digital twin"
      : variableSpend.length > 0
        ? "Local fallback: recurring cash flow + weekday spending simulation"
        : "Synced Sandbox cash flow",
    transparency: {
      lastSyncedAt: item.updated_at ?? null,
      transactionCount: allTransactions.filter((transaction) => !transaction.is_removed).length,
      variableTransactionCount: variableSpend.length,
      latestTransactionDate: allTransactions.filter((transaction) => !transaction.is_removed).map((transaction) => transaction.posted_date).sort().at(-1) ?? null,
      recurringIncomeCount: recurringStreams.filter((stream) => stream.isIncome).length,
      recurringBillCount: recurringStreams.filter((stream) => !stream.isIncome && !stream.isEstimated).length,
      variableSpendingCategories,
      analyticsEngine: analytics ? "calibrated" : "local_fallback",
    },
  };
}
