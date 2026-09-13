import type { DayEvent, ForecastDay, ForecastResult } from "./forecast";

/**
 * The fee cascade: what happens if the projected overdraft is left alone.
 *
 * This is a distinct, honest layer on top of the Phase 1 forecast: the forecast
 * engine itself never models fees (it only projects recurring streams). Here we
 * take the REAL underwater stretch the engine already found and apply the two
 * fee types banks actually charge, so every dollar in the cascade traces back
 * to real projected data plus a documented, realistic fee policy:
 *
 *  1. An overdraft/NSF fee each time a real scheduled transaction posts while
 *     the account can't cover it (the trigger, then each subsequent bounce).
 *  2. A single "extended/sustained overdraft" fee if the account stays
 *     negative for 5+ consecutive days: a real fee category most major banks
 *     charge (e.g. Chase's "if your account is overdrawn for 5 business days").
 *
 * Nothing here is fabricated: the transactions are the real ones from the
 * forecast, and both fee types are standard, disclosed bank practice.
 */

export const OVERDRAFT_FEE = 35;
export const SUSTAINED_OVERDRAFT_THRESHOLD_DAYS = 5;

export type CascadeEventKind = "trigger" | "bounce" | "sustained";

export interface CascadeEvent {
  dayOffset: number;
  date: string;
  kind: CascadeEventKind;
  headline: string;
  detail: string;
  fee: number;
  cumulativeFees: number;
}

export interface CascadeResult {
  triggerDay: ForecastDay;
  windowEndDay: ForecastDay;
  shortfall: number;
  events: CascadeEvent[];
  totalFees: number;
}

function describeTxn(e: DayEvent): string {
  return `${e.name} ($${e.amount.toFixed(2)})`;
}

/**
 * Computes the cascade from the real forecast. Returns null if there's no
 * danger day (nothing to cascade).
 */
export function computeCascade(data: ForecastResult): CascadeResult | null {
  const { series } = data;
  const startIdx = series.findIndex((d) => d.isDanger);
  if (startIdx === -1) return null;

  let endIdx = startIdx;
  while (endIdx + 1 < series.length && series[endIdx + 1].isDanger) {
    endIdx++;
  }

  const events: CascadeEvent[] = [];
  let cumulative = 0;

  const triggerDay = series[startIdx];
  const triggerTxn = triggerDay.events.find((e) => !e.isIncome && !e.isEstimated);
  cumulative += OVERDRAFT_FEE;
  events.push({
    dayOffset: triggerDay.dayOffset,
    date: triggerDay.date,
    kind: "trigger",
    headline: triggerTxn
      ? `${triggerTxn.name} posts: the account overdraws`
      : "The account overdraws",
    detail: triggerTxn
      ? `${describeTxn(triggerTxn)} hits while the balance can't cover it. Standard overdraft fee.`
      : "The projected balance drops below zero. Standard overdraft fee.",
    fee: OVERDRAFT_FEE,
    cumulativeFees: cumulative,
  });

  for (let i = startIdx + 1; i <= endIdx; i++) {
    const day = series[i];
    // Statistical spending velocity moves the balance but does not represent a
    // specific charge the bank can bounce. Only known scheduled debits belong
    // in the fee cascade.
    for (const txn of day.events.filter((e) => !e.isIncome && !e.isEstimated)) {
      cumulative += OVERDRAFT_FEE;
      events.push({
        dayOffset: day.dayOffset,
        date: day.date,
        kind: "bounce",
        headline: `${txn.name} bounces: still underwater`,
        detail: `${describeTxn(txn)} tries to post while the account is still negative. Another fee.`,
        fee: OVERDRAFT_FEE,
        cumulativeFees: cumulative,
      });
    }
  }

  const consecutiveNegativeDays = endIdx - startIdx + 1;
  if (consecutiveNegativeDays >= SUSTAINED_OVERDRAFT_THRESHOLD_DAYS) {
    const thresholdDay = series[startIdx + SUSTAINED_OVERDRAFT_THRESHOLD_DAYS - 1];
    cumulative += OVERDRAFT_FEE;
    events.push({
      dayOffset: thresholdDay.dayOffset,
      date: thresholdDay.date,
      kind: "sustained",
      headline: "Still overdrawn after 5 straight days",
      detail:
        "Most banks add an extended/sustained-overdraft fee once an account stays negative this long.",
      fee: OVERDRAFT_FEE,
      cumulativeFees: cumulative,
    });
  }

  return {
    triggerDay,
    windowEndDay: series[endIdx],
    shortfall: Math.abs(triggerDay.balance),
    events,
    totalFees: cumulative,
  };
}

/**
 * Balances as they'd actually run if the first `stepCount` cascade events
 * have landed (fees are permanent: they reduce every later day too).
 * stepCount = 0 returns the untouched forecast balances.
 */
export function balancesAtCascadeStep(
  series: ForecastDay[],
  events: CascadeEvent[],
  stepCount: number
): number[] {
  const applied = events.slice(0, stepCount);
  return series.map((day) => {
    const feesSoFar = applied
      .filter((e) => e.dayOffset <= day.dayOffset)
      .reduce((sum, e) => sum + e.fee, 0);
    return day.balance - feesSoFar;
  });
}
