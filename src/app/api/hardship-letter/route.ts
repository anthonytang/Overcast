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

/**
 * Gemini only provides neutral wording. Recipient, amount, and due date are
 * calculated on the server from the active forecast and composed afterward,
 * so the model cannot invent or alter financial facts.
 */
export async function POST(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });
    const forecast = await runLiveForecast((await resolveBankUser(request)).id, itemId);
    const danger = forecast?.dangerDays[0];
    const bill = danger?.events.find((event) => !event.isIncome && !event.isEstimated);
    if (!forecast || !danger || !bill) {
      return NextResponse.json({ error: "A detected upcoming bill and overdraft risk are required to draft a letter." }, { status: 422 });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 503 });

    const prompt = [
      "Write two short, empathetic but professional sentences for a hardship-letter draft.",
      "The sender is requesting a brief due-date extension because income arrives shortly after a bill this cycle.",
      "Do not include any names, dollar amounts, dates, numbers, promises, legal claims, or advice.",
      "Do not say the request has been approved. Return JSON only.",
    ].join(" ");
    const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
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
    if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const draft = draftSchema.parse(JSON.parse(text));
    // The model is intentionally forbidden from stating numerical or date-like
    // facts; server-owned facts below are the only ones that reach the letter.
    if (/\d|\$|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(`${draft.requestSentence} ${draft.closingSentence}`)) {
      throw new Error("Generated draft included unvalidated financial facts");
    }

    const letter = [
      `To ${bill.name},`,
      `I'm writing ahead of my payment of ${formatMoney(bill.amount)} due ${formatDate(danger.date)}.`,
      draft.requestSentence,
      draft.closingSentence,
    ];
    return NextResponse.json({ letter, facts: { recipient: bill.name, amountDue: bill.amount, dueDate: danger.date }, model });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not draft hardship letter";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
