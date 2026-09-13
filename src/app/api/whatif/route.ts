import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runLiveForecast } from "@/lib/live-forecast";
import { translateRisk } from "@/lib/risk-model";
import { applyWhatIf } from "@/lib/whatif";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

const schema = z.object({ change: z.object({ kind: z.enum(["skip_stream", "add_income", "delay_income", "reduce_income", "shift_bill"]), streamName: z.string().optional(), amount: z.number().optional(), days: z.number().optional(), label: z.string() }) });

/** Server-owned counterfactual: the browser sends only a structured change;
 * current bank inputs and path samples are always reloaded on the server. */
export async function POST(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });
    const { change } = schema.parse(await request.json());
    const base = await runLiveForecast((await resolveBankUser(request)).id, itemId);
    if (!base?.streams) return NextResponse.json({ error: "Forecast inputs unavailable" }, { status: 422 });
    const result = translateRisk(base, applyWhatIf(base, base.streams, change));
    return NextResponse.json({ result, beforeRisk: base.series.map((day) => day.overdraftProbability ?? 0) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not calculate What-If" }, { status: 400 });
  }
}
