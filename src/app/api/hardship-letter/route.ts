import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runLiveForecast } from "@/lib/live-forecast";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";

const draftSchema = z.object({
  requestSentence: z.string().trim().min(20).max(280),
  closingSentence: z.string().trim().min(8).max(180),
});

function formatMoney(amount: number) { return `$${amount.toFixed(2)}`; }
function formatDate(iso: string) {
  const date = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error("Forecast returned an invalid bill date");
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(date);
}

interface CachedDraft {
  letter: string[];
  facts: { recipient: string; amountDue: number; dueDate: string };
  strategy: string;
  model: string;
  cachedAt: number;
}

const STRATEGY_METADATA = [
  { key: "extension", title: "4-Day Due Date Grace Period", description: "Request shifting due date to align with incoming payroll deposit." },
  { key: "split", title: "50/50 Split Payment Plan", description: "Propose two half-installments to protect liquidity while ensuring full settlement." },
  { key: "waiver", title: "Late-Fee Waiver Guarantee", description: "Request waiving late fees with proof of guaranteed incoming direct deposit." },
];

const draftCache = new Map<string, CachedDraft>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function POST(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });

    let strategy = "extension";
    try {
      const body = await request.json();
      if (body?.strategy && ["extension", "split", "waiver"].includes(body.strategy)) {
        strategy = body.strategy;
      }
    } catch {
      // Empty body defaults to "extension"
    }

    const forecast = await runLiveForecast((await resolveBankUser(request)).id, itemId);
    const danger = forecast?.dangerDays[0];
    const bill = danger?.events.find((event) => !event.isIncome && !event.isEstimated);
    if (!forecast || !danger || !bill) {
      return NextResponse.json({ error: "A detected upcoming bill and overdraft risk are required to draft a letter." }, { status: 422 });
    }

    const cacheKey = `${itemId}:${bill.name}:${bill.amount}:${danger.date}:${strategy}`;
    const cached = draftCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        letter: cached.letter,
        facts: cached.facts,
        strategy: cached.strategy,
        strategies: STRATEGY_METADATA,
        model: cached.model,
        cached: true,
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

    const fallbacks: Record<string, { request: string; closing: string }> = {
      extension: {
        request: "I am writing to request a brief 4-day due-date extension for this billing cycle, as my primary payroll deposit will post shortly after the scheduled charge.",
        closing: "Thank you for your understanding and assistance in helping me keep my account in good standing.",
      },
      split: {
        request: "To ensure timely settlement without overdrafting my checking account, I am proposing to pay 50% on the scheduled due date and the remaining balance upon receipt of my upcoming paycheck.",
        closing: "Please let me know if this structured payment plan is acceptable so I can schedule the first installment immediately.",
      },
      waiver: {
        request: "I am writing to request a temporary courtesy waiver of any late penalty fees, as my direct deposit is scheduled to clear within 72 hours of the billing due date.",
        closing: "I can provide proof of upcoming direct deposit confirmation to keep my account in full standing upon settlement.",
      },
    };

    let requestSentence = fallbacks[strategy]?.request ?? fallbacks.extension.request;
    let closingSentence = fallbacks[strategy]?.closing ?? fallbacks.extension.closing;

    if (apiKey) {
      try {
        const strategyInstructions: Record<string, string> = {
          extension: "The sender requests a brief 4-day due date grace period until direct deposit clears.",
          split: "The sender proposes splitting this invoice into two equal 50% installments across their pay cycle.",
          waiver: "The sender requests a temporary waiver of late penalties citing verified pending direct deposit.",
        };

        const prompt = [
          "Write two short, empathetic but professional sentences for a customer payment negotiation letter draft.",
          strategyInstructions[strategy] ?? strategyInstructions.extension,
          "Do not include any names, dollar amounts, dates, numbers, promises, legal claims, or advice.",
          "Do not say the request has been approved. Return JSON only with requestSentence and closingSentence.",
        ].join(" ");

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 160,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  requestSentence: { type: "STRING" },
                  closingSentence: { type: "STRING" },
                },
                required: ["requestSentence", "closingSentence"],
              },
            },
          }),
        });

        if (response.ok) {
          const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
          if (text) {
            const parsed = draftSchema.safeParse(JSON.parse(text));
            if (parsed.success) {
              const combined = `${parsed.data.requestSentence} ${parsed.data.closingSentence}`;
              if (!/\d|\$|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(combined)) {
                requestSentence = parsed.data.requestSentence;
                closingSentence = parsed.data.closingSentence;
              }
            }
          }
        }
      } catch {
        // Fall back gracefully to the deterministic high-quality sentences
      }
    }

    const header = `To ${bill.name},`;
    const subheader = strategy === "split"
      ? `I'm writing regarding my upcoming payment of ${formatMoney(bill.amount)} due ${formatDate(danger.date)}.`
      : `I'm writing ahead of my payment of ${formatMoney(bill.amount)} due ${formatDate(danger.date)}.`;

    const letter = [
      header,
      subheader,
      requestSentence,
      closingSentence,
    ];

    const result = {
      letter,
      facts: { recipient: bill.name, amountDue: bill.amount, dueDate: danger.date },
      strategy,
      model: apiKey ? model : "rule-based-fallback",
      cachedAt: Date.now(),
    };

    draftCache.set(cacheKey, result);

    return NextResponse.json({
      letter: result.letter,
      facts: result.facts,
      strategy: result.strategy,
      strategies: STRATEGY_METADATA,
      model: result.model,
      cached: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not draft hardship letter";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

