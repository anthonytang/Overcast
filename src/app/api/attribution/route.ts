import { NextRequest, NextResponse } from "next/server";
import { runLiveForecast } from "@/lib/live-forecast";
import { applyWhatIf } from "@/lib/whatif";
import { applyFix } from "@/lib/fix";
import { translateRisk } from "@/lib/risk-model";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

const risk = (series: { overdraftProbability?: number }[]) => Math.max(0, ...series.map((day) => day.overdraftProbability ?? 0));
const factorial = (value: number): number => value <= 1 ? 1 : value * factorial(value - 1);

/** Path-consistent ablation attribution. Each contributor is removed from the
 * same base paths, so contribution is a measurable risk delta, not a label. */
export async function GET(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ contributors: [] });
    const base = await runLiveForecast((await resolveBankUser(request)).id, itemId);
    if (!base?.streams) return NextResponse.json({ contributors: [] });
    const forecast = base;
    const streams = base.streams;
    const beforeRisk = risk(forecast.series);
    type Factor = { key: string; name: string; amount: number; apply: (current: typeof forecast) => typeof forecast };
    const factors: Factor[] = [
      ...streams.filter((stream) => !stream.isIncome && !stream.isEstimated)
        .sort((left, right) => right.amount - left.amount)
        .map((stream) => ({ key: `bill:${stream.name}`, name: stream.name, amount: stream.amount, apply: (current: typeof forecast) => applyWhatIf(current, current.streams ?? [], { kind: "shift_bill", streamName: stream.name, days: 5, label: `Shift ${stream.name}` }) })),
      ...streams.filter((stream) => stream.isIncome).slice(0, 1)
        .map((stream) => ({ key: `income:${stream.name}`, name: `${stream.name} timing`, amount: stream.amount, apply: (current: typeof forecast) => applyWhatIf(current, current.streams ?? [], { kind: "delay_income", streamName: stream.name, days: -5, label: `Move ${stream.name} earlier` }) })),
      ...(forecast.transparency?.variableSpendingCategories ?? []).sort((left, right) => right.share - left.share).slice(0, 2)
        .map((category) => ({ key: `category:${category.name}`, name: `${category.name} spending`, amount: category.share, apply: (current: typeof forecast) => applyFix(current, current.streams ?? [], { deferSubscription: false, transferAmount: 0, reduceEstimatedSpendPercent: category.share * 100 }) })),
    ];
    // Exact Shapley attribution over every detected causal factor. Every subset is
    // evaluated on the identical stored paths, so correlated timing effects
    // are fairly shared instead of double-counted.
    const values = new Map<number, number>();
    const valueFor = (mask: number) => {
      const cached = values.get(mask);
      if (cached !== undefined) return cached;
      let changed = forecast;
      for (let index = 0; index < factors.length; index += 1) if (mask & (1 << index)) changed = factors[index].apply(changed);
      const value = beforeRisk - risk(translateRisk(forecast, changed).series);
      values.set(mask, value);
      return value;
    };
    const contributorCount = factors.length;
    const contributors = factors.map((factor, index) => {
      let contribution = 0;
      for (let mask = 0; mask < (1 << contributorCount); mask += 1) {
        if (mask & (1 << index)) continue;
        const subsetSize = factors.reduce((count, _, position) => count + ((mask & (1 << position)) ? 1 : 0), 0);
        const weight = factorial(subsetSize) * factorial(contributorCount - subsetSize - 1) / factorial(contributorCount);
        contribution += weight * (valueFor(mask | (1 << index)) - valueFor(mask));
      }
      const aloneRisk = risk(translateRisk(forecast, factor.apply(forecast)).series);
      return { name: factor.name, amount: factor.amount, beforeRisk, afterRisk: aloneRisk, contribution: Math.max(0, contribution) };
    }).sort((left, right) => right.contribution - left.contribution);
    // A bill and payroll are not independent when they clear in the same
    // week. Measure their joint counterfactual so the Why panel can name a
    // genuine timing collision rather than pretending every cause adds up.
    const bill = streams.filter((stream) => !stream.isIncome && !stream.isEstimated).sort((left, right) => right.amount - left.amount)[0];
    const income = streams.filter((stream) => stream.isIncome)[0];
    let timingInteraction: null | { label: string; interaction: number; combinedRisk: number } = null;
    if (bill && income) {
      const shiftedBill = applyWhatIf(base, base.streams, { kind: "shift_bill", streamName: bill.name, days: 5, label: `Shift ${bill.name}` });
      const delayedIncome = applyWhatIf(base, base.streams, { kind: "delay_income", streamName: income.name, days: 5, label: `Delay ${income.name}` });
      const combined = applyWhatIf(shiftedBill, shiftedBill.streams ?? [], { kind: "delay_income", streamName: income.name, days: 5, label: `Delay ${income.name}` });
      const billRisk = risk(translateRisk(base, shiftedBill).series);
      const incomeRisk = risk(translateRisk(base, delayedIncome).series);
      const combinedRisk = risk(translateRisk(base, combined).series);
      // Positive values mean the joint timing conflict is worse than the
      // two independent effects would suggest.
      timingInteraction = { label: `${bill.name} × ${income.name}`, interaction: combinedRisk - (billRisk + incomeRisk - beforeRisk), combinedRisk };
    }
    return NextResponse.json({ beforeRisk, contributors, timingInteraction, attributionMethod: "exact_shapley_same_path" });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not calculate attribution" }, { status: 500 }); }
}
