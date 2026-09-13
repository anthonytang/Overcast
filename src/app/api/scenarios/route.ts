import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveBankUser } from "@/lib/supabase/resolve-bank-user";

const eventSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  amount: z.number().positive().max(100_000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["income", "expense"]),
});
const bodySchema = z.object({ events: z.array(eventSchema).max(12) });

async function connectedItem(request: NextRequest) {
  const plaidItemId = request.cookies.get("overcast_sandbox_item")?.value;
  if (!plaidItemId) return null;
  const user = await resolveBankUser(request);
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("bank_items")
    .select("id").eq("user_id", user.id).eq("plaid_item_id", plaidItemId).maybeSingle();
  if (error) throw new Error(`Could not load connected bank: ${error.message}`);
  return data ? { user, itemId: data.id } : null;
}

export async function GET(request: NextRequest) {
  try {
    const connection = await connectedItem(request);
    if (!connection) return NextResponse.json({ events: [] });
    const { data, error } = await createSupabaseAdminClient().from("sandbox_scenarios")
      .select("events,updated_at").eq("bank_item_id", connection.itemId).maybeSingle();
    if (error) throw new Error(`Could not load scenario: ${error.message}`);
    return NextResponse.json({ events: data?.events ?? [], updatedAt: data?.updated_at ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load scenario" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const connection = await connectedItem(request);
    if (!connection) return NextResponse.json({ error: "No connected Sandbox bank" }, { status: 404 });
    const { events } = bodySchema.parse(await request.json());
    const { error } = await createSupabaseAdminClient().from("sandbox_scenarios").upsert({
      user_id: connection.user.id,
      bank_item_id: connection.itemId,
      events,
      updated_at: new Date().toISOString(),
    }, { onConflict: "bank_item_id" });
    if (error) throw new Error(`Could not save scenario: ${error.message}`);
    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save scenario" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const connection = await connectedItem(request);
    if (!connection) return NextResponse.json({ ok: true });
    const { error } = await createSupabaseAdminClient().from("sandbox_scenarios")
      .delete().eq("bank_item_id", connection.itemId);
    if (error) throw new Error(`Could not reset scenario: ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not reset scenario" }, { status: 400 });
  }
}
