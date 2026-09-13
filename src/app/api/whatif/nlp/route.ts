import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runLiveForecast } from "@/lib/live-forecast";
import { translateRisk } from "@/lib/risk-model";
import { applyWhatIf, parseWhatIf, type WhatIfChange } from "@/lib/whatif";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";

const requestSchema = z.object({
  prompt: z.string().trim().min(2).max(280),
});

const geminiChangeSchema = z.object({
  kind: z.enum(["skip_stream", "add_income", "delay_income", "reduce_income", "shift_bill"]),
  streamName: z.string().optional(),
  amount: z.number().optional(),
  days: z.number().optional(),
  label: z.string(),
  reasoning: z.string().optional(),
});

interface CachedNlpWhatIf {
  result: any;
  change: WhatIfChange;
  explanation: string;
  cachedAt: number;
}

const nlpCache = new Map<string, CachedNlpWhatIf>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });

    const body = await request.json();
    const { prompt } = requestSchema.parse(body);

    const user = await resolveBankUser(request);
    const base = await runLiveForecast(user.id, itemId);
    if (!base?.streams) return NextResponse.json({ error: "Forecast inputs unavailable" }, { status: 422 });

    const normPrompt = prompt.toLowerCase().trim();
    const cacheKey = `${itemId}:${normPrompt}`;
    const cached = nlpCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        result: cached.result,
        change: cached.change,
        explanation: cached.explanation,
        cached: true,
      });
    }

    let parsedChange: WhatIfChange | null = null;
    let explanation = `Simulated: "${prompt}"`;

    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

    if (apiKey) {
      try {
        const streamDescriptions = base.streams.map((s) => `${s.name} (${s.isIncome ? "income" : "bill/expense"}, $${s.amount.toFixed(2)})`).join(", ");
        const sysPrompt = [
          `You are an expert financial counterfactual extractor for a cashflow simulator.`,
          `Available user cash streams: [${streamDescriptions}].`,
          `Convert the user's plain-language what-if scenario into exact structured simulation parameters:`,
          `- kind: "skip_stream" | "add_income" | "delay_income" | "reduce_income" | "shift_bill"`,
          `- streamName: the exact matching stream name from available streams if applicable`,
          `- amount: dollar amount if specified or implied`,
          `- days: number of days shift or delay if specified`,
          `- label: short human-readable description (max 8 words)`,
          `- reasoning: 1 brief sentence explaining the extracted parameters`,
        ].join(" ");

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [{ text: `${sysPrompt}\n\nUser scenario: "${prompt}"` }] },
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 200,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  kind: { type: "STRING", enum: ["skip_stream", "add_income", "delay_income", "reduce_income", "shift_bill"] },
                  streamName: { type: "STRING" },
                  amount: { type: "NUMBER" },
                  days: { type: "INTEGER" },
                  label: { type: "STRING" },
                  reasoning: { type: "STRING" },
                },
                required: ["kind", "label"],
              },
            },
          }),
        });

        if (response.ok) {
          const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
          if (text) {
            const parsed = geminiChangeSchema.safeParse(JSON.parse(text));
            if (parsed.success) {
              parsedChange = {
                kind: parsed.data.kind,
                streamName: parsed.data.streamName,
                amount: parsed.data.amount,
                days: parsed.data.days,
                label: parsed.data.label,
              };
              if (parsed.data.reasoning) {
                explanation = parsed.data.reasoning;
              }
            }
          }
        }
      } catch {
        // Fall back to rule-based parser on any Gemini error or rate limit
      }
    }

    // Deterministic fallback if Gemini wasn't used or failed
    if (!parsedChange) {
      const fallbackResult = parseWhatIf(prompt, base.streams);
      if (fallbackResult.change) {
        parsedChange = fallbackResult.change;
        explanation = `Parsed using keyword recognition: ${parsedChange.label}`;
      } else {
        // Generic fallback if no specific match
        const primaryIncome = base.streams.find((s) => s.isIncome);
        parsedChange = {
          kind: "delay_income",
          streamName: primaryIncome?.name,
          days: 3,
          label: `Simulated 3-day income delay for ${primaryIncome?.name ?? "paycheck"}`,
        };
        explanation = `Applied 3-day income delay counterfactual`;
      }
    }

    const modifiedForecast = applyWhatIf(base, base.streams, parsedChange);
    const result = translateRisk(base, modifiedForecast);

    const cachedData: CachedNlpWhatIf = {
      result,
      change: parsedChange,
      explanation,
      cachedAt: Date.now(),
    };
    nlpCache.set(cacheKey, cachedData);

    return NextResponse.json({
      result,
      change: parsedChange,
      explanation,
      cached: false,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not process scenario" }, { status: 400 });
  }
}
