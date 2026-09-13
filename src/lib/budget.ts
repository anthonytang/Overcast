import type { ForecastResult, Stream } from "./forecast";
import { applyFix, minimumTransferNeeded } from "./fix";

/**
 * Auto-Budget: a generated monthly allocation, framed entirely around the
 * waterline. Not a blank-template budgeting tool: every number here is
 * DERIVED from the real recurring streams and the real forecast engine.
 *
 * The budget has three parts, mirroring how the app has already explained
 * the danger day:
 *  1. Fixed obligations (rent, utilities): respected as-is, never touched.
 *  2. A recommended safety buffer: reusing the exact real number the Fix
 *     panel already computes (`minimumTransferNeeded`). In this scenario the
 *     overdraft is a TIMING problem (rent lands before the paycheck does),
 *     not an overspending problem, so honesty requires surfacing the buffer
 *     as the thing that actually closes the gap: not implying discretionary
 *     cuts alone would do it, when the real numbers show they can't.
 *  3. A discretionary ceiling: the real recurring discretionary spend,
 *     plus the actual computed maximum a category could reach (holding the
 *     buffer + fixed obligations fixed) before the projection goes back
 *     underwater. Computed by binary search against the real project()
 *     engine, not asserted.
 */

export type BudgetCategory = "income" | "fixed" | "discretionary";

export interface BudgetLine {
  streamName: string;
  label: string;
  amount: number;
  cadenceDays: number;
  cadenceLabel: string;
  monthlyRate: number;
  category: BudgetCategory;
}

export interface AutoBudget {
  income: BudgetLine[];
  fixed: BudgetLine[];
  discretionary: BudgetLine[];
  totalMonthlyIncome: number;
  totalFixed: number;
  totalDiscretionaryMonthlyRate: number;
  recommendedBuffer: number;
  dangerDate: string | null;
  /** Real recompute: fixed respected + buffer applied + discretionary AT ITS CURRENT RATE stays above water. */
  budgetPreventsOverdraft: boolean;
}

/**
 * The forecast engine doesn't carry a spending category (Plaid's recurring
 * API would supply one in production); rent/utilities are true fixed
 * obligations, everything else is flexible/discretionary. Same
 * classification `lib/insights.ts` already uses, kept local here rather
 * than shared to avoid coupling two independent features to one lookup.
 */
const FIXED_STREAM_NAMES = new Set(["SUNNYSIDE RENT", "CITY ELECTRIC"]);

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function cadenceLabel(amount: number, cadenceDays: number): string {
  if (cadenceDays <= 7) return `$${amount.toFixed(2)}/wk`;
  if (cadenceDays >= 28) return `$${amount.toFixed(2)}/mo`;
  return `$${amount.toFixed(2)} every ${cadenceDays} days`;
}

function monthlyRate(amount: number, cadenceDays: number): number {
  return Math.round(amount * (30 / cadenceDays) * 100) / 100;
}

export function computeAutoBudget(data: ForecastResult, streams: Stream[]): AutoBudget {
  const income: BudgetLine[] = [];
  const fixed: BudgetLine[] = [];
  const discretionary: BudgetLine[] = [];

  for (const s of streams) {
    const category: BudgetCategory = s.isIncome
      ? "income"
      : FIXED_STREAM_NAMES.has(s.name)
        ? "fixed"
        : "discretionary";
    const line: BudgetLine = {
      streamName: s.name,
      label: titleCase(s.name),
      amount: s.amount,
      cadenceDays: s.cadenceDays,
      cadenceLabel: cadenceLabel(s.amount, s.cadenceDays),
      monthlyRate: monthlyRate(s.amount, s.cadenceDays),
      category,
    };
    (category === "income" ? income : category === "fixed" ? fixed : discretionary).push(line);
  }

  const totalMonthlyIncome = income.reduce((sum, l) => sum + l.monthlyRate, 0);
  const totalFixed = fixed.reduce((sum, l) => sum + l.monthlyRate, 0);
  const totalDiscretionaryMonthlyRate = discretionary.reduce((sum, l) => sum + l.monthlyRate, 0);
  const recommendedBuffer = minimumTransferNeeded(data);
  const dangerDate = data.dangerDays[0]?.date ?? null;

  const buffered =
    recommendedBuffer > 0
      ? applyFix(data, streams, { deferSubscription: false, transferAmount: recommendedBuffer })
      : data;
  const budgetPreventsOverdraft = buffered.dangerDays.length === 0;

  return {
    income,
    fixed,
    discretionary,
    totalMonthlyIncome,
    totalFixed,
    totalDiscretionaryMonthlyRate,
    recommendedBuffer,
    dangerDate,
    budgetPreventsOverdraft,
  };
}

/**
 * Recomputes the real forecast with one discretionary stream's amount
 * replaced and the recommended buffer applied: the live preview behind the
 * budget's one adjustable allowance (the "light tweak").
 */
export function previewBudgetTweak(
  data: ForecastResult,
  streams: Stream[],
  targetStreamName: string,
  newAmount: number,
  bufferAmount: number
): ForecastResult {
  const modified = streams.map((s) => (s.name === targetStreamName ? { ...s, amount: newAmount } : s));
  return applyFix(data, modified, { deferSubscription: false, transferAmount: bufferAmount });
}

/**
 * The real, computed ceiling for one discretionary stream: the highest
 * amount it could run at: holding fixed obligations and the recommended
 * buffer constant: before the projection dips back underwater. Found by
 * binary search against the real project() engine (via applyFix), not
 * asserted or templated.
 */
export function computeSafeCeiling(
  data: ForecastResult,
  streams: Stream[],
  targetStreamName: string,
  bufferAmount: number,
  searchMax = 400
): number {
  const feasible = (amount: number) =>
    previewBudgetTweak(data, streams, targetStreamName, amount, bufferAmount).dangerDays.length === 0;

  if (!feasible(0)) return 0;
  if (feasible(searchMax)) return searchMax;

  let lo = 0;
  let hi = searchMax;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}
