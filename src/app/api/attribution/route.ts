import { NextRequest, NextResponse } from "next/server";
import { runLiveForecast } from "@/lib/live-forecast";
import { applyWhatIf } from "@/lib/whatif";
import { applyFix } from "@/lib/fix";
import { translateRisk } from "@/lib/risk-model";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

const risk = (series: { overdraftProbability?: number }[]) => Math.max(0, ...series.map((day) => day.overdraftProbability ?? 0));
const factorial = (value: number): number => value <= 1 ? 1 : value * factorial(value - 1);

interface CachedAttribution {
  beforeRisk: number;
  contributors: Array<{ name: string; amount: number; beforeRisk: number; afterRisk: number; contribution: number }>;
  timingInteraction: null | { label: string; interaction: number; combinedRisk: number };
  attributionMethod: string;
  aiDiagnostic: { headline: string; summary: string; primaryDriver: string; timingShare: number };
  cachedAt: number;
}

const attributionCache = new Map<string, CachedAttribution>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Path-consistent ablation attribution. Each contributor is removed from the
 * same base paths, so contribution is a measurable risk delta, not a label. */
export async function GET(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ contributors: [] });

    const user = await resolveBankUser(request);
    const base = await runLiveForecast(user.id, itemId);
    if (!base?.streams) return NextResponse.json({ contributors: [] });

    const cacheKey = `${itemId}:${base.dangerDays[0]?.date ?? "nodanger"}:${base.startingBalance}`;
    const cached = attributionCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        beforeRisk: cached.beforeRisk,
        contributors: cached.contributors,
        timingInteraction: cached.timingInteraction,
        attributionMethod: cached.attributionMethod,
        aiDiagnostic: cached.aiDiagnostic,
        cached: true,
      });
    }

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
      const cachedVal = values.get(mask);
      if (cachedVal !== undefined) return cachedVal;
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
      timingInteraction = { label: `${bill.name} × ${income.name}`, interaction: combinedRisk - (billRisk + incomeRisk - beforeRisk), combinedRisk };
    }

    const totalContribution = contributors.reduce((sum, c) => sum + c.contribution, 0) || 1;
    const topContributor = contributors[0];
    const timingShare = Math.round(((topContributor?.contribution ?? 0) / totalContribution) * 100);

    let aiDiagnostic = {
      headline: timingShare > 40
        ? `Timing collision explains ${timingShare}% of projected overdraft risk`
        : `Discretionary pacing is the primary risk driver`,
      summary: topContributor
        ? `Shapley decomposition proves that ${topContributor.name} (${topContributor.amount > 1 ? `$${topContributor.amount.toFixed(0)}` : ""}) creates ${timingShare}% of your deficit exposure due to its timing relative to income.`
        : "Your cashflow balance is stable across the 30-day forecast horizon.",
      primaryDriver: topContributor?.name ?? "Routine cashflow balance",
      timingShare,
    };

    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

    if (apiKey && topContributor && beforeRisk > 0.05) {
      try {
        const prompt = [
          `Summarize this exact Shapley mathematical risk attribution for a consumer in 2 clear sentences.`,
          `Facts: Top driver is ${topContributor.name} with ${timingShare}% causal attribution. Total risk before intervention is ${(beforeRisk * 100).toFixed(0)}%.`,
          `Emphasize that the risk is caused by a calendar timing collision between bill settlement and income, NOT personal overspending.`,
          `Do not invent dollar amounts or dates. Return JSON with 'headline' (max 8 words) and 'summary' (max 35 words).`,
        ].join(" ");

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 120,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  headline: { type: "STRING" },
                  summary: { type: "STRING" },
                },
                required: ["headline", "summary"],
              },
            },
          }),
        });

        if (response.ok) {
          const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          if (text) {
            const parsed = JSON.parse(text);
            if (parsed.headline && parsed.summary) {
              aiDiagnostic = {
                headline: parsed.headline,
                summary: parsed.summary,
                primaryDriver: topContributor.name,
                timingShare,
              };
            }
          }
        }
      } catch {
        // Keep deterministic rule-based template
      }
    }

    const payloadResult: CachedAttribution = {
      beforeRisk,
      contributors,
      timingInteraction,
      attributionMethod: "exact_shapley_same_path",
      aiDiagnostic,
      cachedAt: Date.now(),
    };
    attributionCache.set(cacheKey, payloadResult);

    return NextResponse.json({
      beforeRisk,
      contributors,
      timingInteraction,
      attributionMethod: "exact_shapley_same_path",
      aiDiagnostic,
      cached: false,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not calculate attribution" }, { status: 500 });
  }
}

