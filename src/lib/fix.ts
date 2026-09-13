import type { ForecastResult, Stream } from "./forecast";
import { deriveTodayFromSeries, project } from "./forecast";

/**
 * The Fix: real interventions, recomputed through the same forecast engine.
 *
 * Nothing here paints the timeline green by itself. Each option modifies the
 * actual recurring streams (deferring a charge the user controls directly, or
 * adding a real transfer) and re-runs project(): the identical Phase 1
 * function used for the original forecast. Whether an option actually clears
 * every danger day depends on the real numbers; it isn't assumed.
 */

/** The one discretionary item small enough to defer unilaterally (no provider needed). */
export const DEFER_TARGET_STREAM = "STREAMFLIX";
/** Pushes it well past the recovery day so it no longer lands in the danger window. */
export const DEFER_PUSH_DAYS = 21;

export interface FixOptions {
  deferSubscription: boolean;
  transferAmount: number; // 0 = no transfer
  /** Live Sandbox forecasts choose an actual upcoming recurring outflow. */
  deferStreamName?: string;
  /** Decision-engine plans can test the smallest viable deferral window. */
  deferDays?: number;
  /** An advisory reduction applied only to the estimated variable-spend flow. */
  reduceEstimatedSpendPercent?: number;
  /** Day selected by the optimizer after checking every earlier waterline. */
  transferDay?: number;
}

export function applyFix(
  baseResult: ForecastResult,
  baseStreams: Stream[],
  options: FixOptions
): ForecastResult {
  let streams = baseStreams.map((s) => ({ ...s }));

  if (options.deferSubscription) {
    streams = streams.map((s) =>
      s.name === (options.deferStreamName ?? DEFER_TARGET_STREAM)
        ? { ...s, firstDay: s.firstDay + (options.deferDays ?? DEFER_PUSH_DAYS) }
        : s
    );
  }

  if (options.reduceEstimatedSpendPercent && options.reduceEstimatedSpendPercent > 0) {
    const factor = Math.max(0, 1 - options.reduceEstimatedSpendPercent / 100);
    streams = streams.map((stream) => stream.isEstimated ? { ...stream, amount: stream.amount * factor } : stream);
  }

  if (options.transferAmount > 0) {
    streams = [
      ...streams,
      {
        name: "SAVINGS TRANSFER",
        amount: options.transferAmount,
        // Large cadence so it only ever posts once, on day 1.
        cadenceDays: baseResult.horizonDays + 1,
        isIncome: true,
        firstDay: Math.max(1, Math.min(baseResult.horizonDays, options.transferDay ?? 1)),
      },
    ];
  }

  const today = deriveTodayFromSeries(baseResult.series);
  return project(
    streams,
    baseResult.startingBalance,
    baseResult.buffer,
    baseResult.horizonDays,
    today
  );
}

/** The smallest transfer (rounded up to the dollar) that clears every danger day. */
export function minimumTransferNeeded(result: ForecastResult): number {
  const minBalance = Math.min(0, ...result.series.map((d) => d.balance));
  return minBalance < 0 ? Math.ceil(-minBalance) : 0;
}
