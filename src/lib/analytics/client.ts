import "server-only";

import type { AnalyticsRequest, AnalyticsResponse } from "./types";

function analyticsUrl() {
  return process.env.ANALYTICS_URL?.replace(/\/$/, "") ?? null;
}

/** Calls the separate inference service only when it has been explicitly
 * configured. The caller keeps a transparent local fallback for development. */
export async function runAnalyticsForecast(input: AnalyticsRequest): Promise<AnalyticsResponse | null> {
  const baseUrl = analyticsUrl();
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl}/forecast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        starting_balance: input.startingBalance,
        buffer: input.buffer,
        horizon_days: input.horizonDays,
        start_date: input.startDate,
        streams: input.streams.map((stream) => ({
          name: stream.name, amount: stream.amount, cadence_days: stream.cadenceDays,
          is_income: stream.isIncome, first_day: stream.firstDay, is_estimated: stream.isEstimated ?? false,
        })),
        transactions: input.transactions.map((transaction) => ({
          amount: transaction.amount, posted_date: transaction.postedDate, description: transaction.description,
          primary_category: transaction.primaryCategory ?? null, detailed_category: transaction.detailedCategory ?? null,
        })),
        savings_available: input.savingsAvailable,
        available_balance: input.availableBalance ?? null, current_balance: input.currentBalance ?? null,
        pending_transactions: (input.pendingTransactions ?? []).map((transaction) => ({ amount: transaction.amount, authorized_date: transaction.authorizedDate, description: transaction.description })),
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json() as AnalyticsResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
