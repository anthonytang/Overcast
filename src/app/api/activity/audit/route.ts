import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

export const runtime = "nodejs";

interface CachedAudit {
  subscriptions: Array<{ name: string; amount: number; cadence: string; category: string }>;
  monthlySubscriptionTotal: number;
  anomalies: Array<{ merchant: string; note: string; severity: "info" | "warning" }>;
  aiSummary: string;
  cachedAt: number;
}

const auditCache = new Map<string, CachedAudit>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const plaidItemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!plaidItemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });

    const cached = auditCache.get(plaidItemId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return NextResponse.json({ ...cached, cached: true });
    }

    const db = createSupabaseAdminClient();
    const user = await resolveBankUser(request);
    const { data: item } = await db
      .from("bank_items")
      .select("id")
      .eq("user_id", user.id)
      .eq("plaid_item_id", plaidItemId)
      .maybeSingle();
    if (!item) return NextResponse.json({ error: "Bank item not found" }, { status: 404 });

    const { data: accounts } = await db
      .from("bank_accounts")
      .select("id")
      .eq("bank_item_id", item.id)
      .eq("user_id", user.id);
    const accountIds = (accounts ?? []).map((account) => account.id);
    if (!accountIds.length) return NextResponse.json({ subscriptions: [], anomalies: [], monthlySubscriptionTotal: 0 });

    const { data: transactions } = await db
      .from("transactions")
      .select("id,posted_date,description,merchant_name,amount,primary_category,detailed_category")
      .in("account_id", accountIds)
      .eq("is_removed", false)
      .order("posted_date", { ascending: false })
      .limit(150);

    const txs = transactions ?? [];

    // Group transactions by normalized merchant name
    const merchantMap = new Map<string, Array<{ date: string; amount: number; category: string }>>();
    for (const tx of txs) {
      const name = (tx.merchant_name || tx.description || "Unknown").trim().toUpperCase();
      const list = merchantMap.get(name) ?? [];
      list.push({
        date: tx.posted_date,
        amount: Number(tx.amount),
        category: tx.primary_category || tx.detailed_category || "General",
      });
      merchantMap.set(name, list);
    }

    const subscriptions: Array<{ name: string; amount: number; cadence: string; category: string }> = [];
    const anomalies: Array<{ merchant: string; note: string; severity: "info" | "warning" }> = [];

    for (const [name, occurrences] of merchantMap.entries()) {
      const expenseOccurrences = occurrences.filter((o) => o.amount > 0);
      if (expenseOccurrences.length >= 2) {
        const latestAmount = expenseOccurrences[0].amount;
        const prevAmount = expenseOccurrences[1].amount;
        const isSubscriptionCat = /subscription|streaming|service|utility|utilities|fitness|membership/i.test(expenseOccurrences[0].category) ||
          /netflix|spotify|hulu|apple|gym|prime|disney|electric/i.test(name);

        if (isSubscriptionCat || expenseOccurrences.length >= 3) {
          subscriptions.push({
            name,
            amount: latestAmount,
            cadence: "Monthly",
            category: expenseOccurrences[0].category,
          });
        }

        if (latestAmount > prevAmount && (latestAmount - prevAmount) >= 1) {
          anomalies.push({
            merchant: name,
            note: `Amount increased from $${prevAmount.toFixed(2)} to $${latestAmount.toFixed(2)} (+${((latestAmount - prevAmount) / prevAmount * 100).toFixed(0)}%)`,
            severity: "warning",
          });
        }
      }
    }

    const monthlySubscriptionTotal = subscriptions.reduce((sum, s) => sum + s.amount, 0);

    let aiSummary = subscriptions.length > 0
      ? `Audited ${txs.length} transactions: identified ${subscriptions.length} recurring subscription commitments ($${monthlySubscriptionTotal.toFixed(2)}/mo)${anomalies.length > 0 ? ` with ${anomalies.length} price change detected` : ""}.`
      : `Audited ${txs.length} transactions with no irregular recurring anomalies detected.`;

    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

    if (apiKey && subscriptions.length > 0) {
      try {
        const prompt = [
          `Summarize this transaction audit in 1 concise sentence (max 25 words).`,
          `Facts: ${subscriptions.length} recurring subscriptions ($${monthlySubscriptionTotal.toFixed(2)}/mo total). ${anomalies.length} price anomalies found.`,
          `Keep tone factual and objective. Do not give generic savings advice. Return plain text only.`,
        ].join(" ");

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 60,
            },
          }),
        });

        if (response.ok) {
          const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          const text = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) {
            aiSummary = text;
          }
        }
      } catch {
        // Keep rule-based summary
      }
    }

    const result: CachedAudit = {
      subscriptions: subscriptions.slice(0, 8),
      monthlySubscriptionTotal,
      anomalies: anomalies.slice(0, 4),
      aiSummary,
      cachedAt: Date.now(),
    };

    auditCache.set(plaidItemId, result);

    return NextResponse.json({ ...result, cached: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not audit activity" }, { status: 500 });
  }
}
