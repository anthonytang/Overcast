import type { ForecastResult, Stream } from "./forecast";
import { deriveTodayFromSeries, project } from "./forecast";

/**
 * The What-If Assistant: parses a plain-language question into a STRUCTURED
 * change to the forecast inputs, then re-runs the real project() engine.
 *
 * The parser's only job is producing a { kind, streamName, amount, days }
 * change. It never invents a balance, a date, a fee, or advice: every
 * number shown to the user comes out of the recomputed ForecastResult below.
 * This is a deterministic keyword parser (no LLM call, no network), so the
 * supported question patterns work identically offline and in a demo.
 */

export type WhatIfKind =
  | "skip_stream"
  | "add_income"
  | "delay_income"
  | "reduce_income"
  | "shift_bill";

export interface WhatIfChange {
  kind: WhatIfKind;
  streamName?: string;
  amount?: number;
  days?: number;
  label: string;
}

export interface WhatIfParseResult {
  change: WhatIfChange | null;
  clarification?: string;
}

export const WHATIF_FALLBACK_MESSAGE =
  "I can try what-ifs about your income, spending, or bill timing: can you rephrase? (e.g. \"skip groceries this week\", \"$800 side gig\", \"paycheck is 5 days late\", \"move rent 3 days earlier\")";

function findAmount(text: string): number | null {
  const m = text.match(/\$\s?(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function findDays(text: string): number | null {
  const m = text.match(/(\d+)\s*days?\b/);
  return m ? parseInt(m[1], 10) : null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const BILL_ALIASES: Record<string, string> = {
  rent: "SUNNYSIDE RENT",
  electric: "CITY ELECTRIC",
  electricity: "CITY ELECTRIC",
  grocery: "GROCERY MART",
  groceries: "GROCERY MART",
  streamflix: "STREAMFLIX",
  musicwave: "MUSICWAVE",
};

function findBillStream(text: string, streams: Stream[]): Stream | null {
  for (const [alias, streamName] of Object.entries(BILL_ALIASES)) {
    if (text.includes(alias)) {
      return streams.find((s) => s.name === streamName) ?? null;
    }
  }
  const terms = ["rent", "electric", "utility", "utilities", "subscription", "insurance", "phone"];
  return streams.find((stream) => !stream.isIncome && terms.some((term) => text.includes(term) && stream.name.toLowerCase().includes(term))) ?? null;
}

/**
 * Deterministic keyword parser. Matches the question against the supported
 * intents in priority order; if nothing matches confidently, it says so
 * instead of guessing.
 */
export function parseWhatIf(questionRaw: string, streams: Stream[]): WhatIfParseResult {
  const text = questionRaw.trim().toLowerCase();
  if (!text) return { change: null, clarification: WHATIF_FALLBACK_MESSAGE };

  // 1. Skip/cut discretionary spending (groceries / eating out / food).
  if (
    /\b(skip|cut|cancel|pause|avoid)\b/.test(text) &&
    /\b(groceries|grocery|eating out|food|dining|takeout)\b/.test(text)
  ) {
    const stream = streams.find((s) => /grocer|food|dining|restaurant/i.test(s.name)) ?? streams.find((s) => s.isEstimated);
    if (stream) {
      return {
        change: {
          kind: "skip_stream",
          streamName: stream.name,
          label: `Skip this week's ${titleCase(stream.name)} run ($${stream.amount.toFixed(2)})`,
        },
      };
    }
  }

  // 2. One-time extra income (side gig / freelance / bonus / selling something).
  if (/\b(side gig|side hustle|freelance|extra income|gig|bonus)\b/.test(text)) {
    const amount = findAmount(text);
    if (amount === null) {
      return {
        change: null,
        clarification:
          'How much would that bring in? Try including a dollar amount, like "$200 side gig."',
      };
    }
    return {
      change: {
        kind: "add_income",
        amount,
        label: `Pick up a $${amount.toFixed(2)} side gig`,
      },
    };
  }

  // 3. Paycheck late or smaller.
  if (/\b(paycheck|payroll|income|pay)\b/.test(text)) {
    const stream = streams.find((s) => s.name === "ACME PAYROLL") ?? streams.find((s) => s.isIncome);
    if (stream && /\b(late|delayed|pushed back|postponed|slips?)\b/.test(text)) {
      const days = findDays(text) ?? 5;
      return {
        change: {
          kind: "delay_income",
          streamName: stream.name,
          days,
          label: `Paycheck arrives ${days} day${days === 1 ? "" : "s"} late`,
        },
      };
    }
    if (stream && /\b(smaller|less|reduced|short|cut|lower)\b/.test(text)) {
      const amount = findAmount(text) ?? 300;
      return {
        change: {
          kind: "reduce_income",
          streamName: stream.name,
          amount,
          label: `Paycheck is $${amount.toFixed(2)} smaller`,
        },
      };
    }
  }

  // 4. Shift a bill's due date (rent / electric / subscriptions: not the paycheck).
  if (/\b(move|shift|push|delay|postpone|reschedule)\b/.test(text)) {
    const stream = findBillStream(text, streams);
    if (stream) {
      const days = findDays(text) ?? 3;
      const earlier = /\b(earlier|sooner|up|forward)\b/.test(text);
      const signedDays = earlier ? -days : days;
      return {
        change: {
          kind: "shift_bill",
          streamName: stream.name,
          days: signedDays,
          label: `Move ${titleCase(stream.name)} ${days} day${days === 1 ? "" : "s"} ${earlier ? "earlier" : "later"}`,
        },
      };
    }
  }

  return { change: null, clarification: WHATIF_FALLBACK_MESSAGE };
}

/**
 * Applies a parsed change to the base streams and re-runs the REAL project()
 * engine: identical to how the Fix recomputes. A stream occurrence is
 * "cancelled" or "shifted" by adding a one-time offsetting stream (cadence >
 * horizon, so it only ever posts once) rather than mutating the recurring
 * definition: so only the NEXT occurrence changes, future ones stay on
 * their original cadence, exactly as a real one-off change would behave.
 */
export function applyWhatIf(
  baseResult: ForecastResult,
  baseStreams: Stream[],
  change: WhatIfChange
): ForecastResult {
  const horizon = baseResult.horizonDays;
  const streams = baseStreams.map((s) => ({ ...s }));
  const extra: Stream[] = [];

  function cancelOccurrence(streamName: string): { stream: Stream; day: number } | null {
    const s = streams.find((st) => st.name === streamName);
    if (!s) return null;
    const day = s.firstDay;
    if (day < 1 || day > horizon) return null;
    extra.push({
      name: `${streamName} (offset)`,
      amount: s.amount,
      cadenceDays: horizon + 1,
      isIncome: !s.isIncome,
      firstDay: day,
    });
    return { stream: s, day };
  }

  switch (change.kind) {
    case "skip_stream": {
      if (change.streamName) cancelOccurrence(change.streamName);
      break;
    }
    case "add_income": {
      extra.push({
        name: "SIDE INCOME",
        amount: change.amount ?? 0,
        cadenceDays: horizon + 1,
        isIncome: true,
        firstDay: 1,
      });
      break;
    }
    case "delay_income": {
      if (change.streamName) {
        const res = cancelOccurrence(change.streamName);
        if (res) {
          // Clamp to day 1 rather than dropping: a shift that lands before
          // today just happens as soon as possible, it doesn't vanish.
          const newDay = Math.max(1, res.day + (change.days ?? 0));
          if (newDay <= horizon) {
            extra.push({
              name: `${change.streamName} (delayed)`,
              amount: res.stream.amount,
              cadenceDays: horizon + 1,
              isIncome: true,
              firstDay: newDay,
            });
          }
        }
      }
      break;
    }
    case "reduce_income": {
      if (change.streamName) {
        const res = cancelOccurrence(change.streamName);
        if (res) {
          const reduced = Math.max(res.stream.amount - (change.amount ?? 0), 0);
          extra.push({
            name: `${change.streamName} (reduced)`,
            amount: reduced,
            cadenceDays: horizon + 1,
            isIncome: true,
            firstDay: res.day,
          });
        }
      }
      break;
    }
    case "shift_bill": {
      if (change.streamName) {
        const res = cancelOccurrence(change.streamName);
        if (res) {
          const newDay = Math.max(1, res.day + (change.days ?? 0));
          if (newDay <= horizon) {
            extra.push({
              name: `${change.streamName} (shifted)`,
              amount: res.stream.amount,
              cadenceDays: horizon + 1,
              isIncome: false,
              firstDay: newDay,
            });
          }
        }
      }
      break;
    }
  }

  const today = deriveTodayFromSeries(baseResult.series);
  return project([...streams, ...extra], baseResult.startingBalance, baseResult.buffer, horizon, today);
}

export interface WhatIfOutcome {
  direction: "better" | "worse" | "same";
  headline: string;
  detail: string;
}

function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatDateLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[m - 1]} ${d}`;
}

/**
 * Honest before/after summary: grounded entirely in the two recomputed
 * ForecastResults. Framed as hypothetical throughout ("would"/"if"), never
 * as something that already happened.
 */
export function summarizeWhatIf(before: ForecastResult, after: ForecastResult): WhatIfOutcome {
  const beforeDanger = before.dangerDays;
  const afterDanger = after.dangerDays;
  const beforeMin = Math.min(0, ...before.series.map((d) => d.balance));
  const afterMin = Math.min(0, ...after.series.map((d) => d.balance));

  if (beforeDanger.length > 0 && afterDanger.length === 0) {
    return {
      direction: "better",
      headline: "That would clear it. You'd stay above water the whole 30 days.",
      detail: `No more overdraft on ${formatDateLabel(beforeDanger[0].date)}: the balance never drops below ${formatMoney(after.buffer)}.`,
    };
  }

  if (afterDanger.length === 0 && beforeDanger.length === 0) {
    return {
      direction: "same",
      headline: "You were never going under anyway: this wouldn't change anything.",
      detail: "The projection stays above water either way.",
    };
  }

  if (beforeDanger.length === 0 && afterDanger.length > 0) {
    return {
      direction: "worse",
      headline: `That would push you under on ${formatDateLabel(afterDanger[0].date)}: you weren't before.`,
      detail: `Balance would drop to ${formatMoney(afterMin)} on its worst day.`,
    };
  }

  const beforeFirst = beforeDanger[0];
  const afterFirst = afterDanger[0];
  const worse =
    afterDanger.length > beforeDanger.length ||
    afterMin < beforeMin ||
    afterFirst.dayOffset < beforeFirst.dayOffset;
  const better =
    !worse &&
    (afterDanger.length < beforeDanger.length ||
      afterMin > beforeMin ||
      afterFirst.dayOffset > beforeFirst.dayOffset);

  if (afterFirst.dayOffset !== beforeFirst.dayOffset) {
    return {
      direction: worse ? "worse" : "better",
      headline: worse
        ? `That's worse: you'd go under on ${formatDateLabel(afterFirst.date)} instead of ${formatDateLabel(beforeFirst.date)}.`
        : `That helps: the overdraft moves from ${formatDateLabel(beforeFirst.date)} to ${formatDateLabel(afterFirst.date)}.`,
      detail: `Underwater ${afterDanger.length} day${afterDanger.length === 1 ? "" : "s"} instead of ${beforeDanger.length}, lowest balance ${formatMoney(afterMin)} vs ${formatMoney(beforeMin)} before.`,
    };
  }

  if (worse) {
    return {
      direction: "worse",
      headline: `That's not enough: you'd still go under on ${formatDateLabel(afterFirst.date)}, and it gets worse from there.`,
      detail: `Underwater ${afterDanger.length} days instead of ${beforeDanger.length}, dropping to ${formatMoney(afterMin)} instead of ${formatMoney(beforeMin)}.`,
    };
  }

  if (better) {
    return {
      direction: "better",
      headline: `That helps: you'd still go under on ${formatDateLabel(afterFirst.date)}, but not as deep.`,
      detail: `Lowest balance improves to ${formatMoney(afterMin)}, up from ${formatMoney(beforeMin)}.`,
    };
  }

  return {
    direction: "same",
    headline: "That doesn't move the needle: same danger window either way.",
    detail: `Still underwater ${afterDanger.length} days, lowest balance ${formatMoney(afterMin)}.`,
  };
}
