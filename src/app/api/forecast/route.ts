import { NextRequest, NextResponse } from "next/server";
import { runLiveForecast } from "@/lib/live-forecast";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

/**
 * Uses only a connected Sandbox account. We deliberately never substitute
 * demo cash flow for a user who has not connected a bank.
 */
export async function GET(request: NextRequest) {
  try {
    const itemId = request.cookies.get("overcast_sandbox_item")?.value;
    if (!itemId) return NextResponse.json({ status: "unconnected" });
    const result = await runLiveForecast((await resolveBankUser(request)).id, itemId);
    return NextResponse.json(result ?? { status: "unconnected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build forecast";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
