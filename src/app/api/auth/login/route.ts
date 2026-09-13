import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || "test@gmail.com").trim().toLowerCase();
    const password = body.password || "test123";

    const db = createSupabaseAdminClient();
    
    // Check if user exists in Supabase, create if not
    let userRecord = null;
    try {
      const { data: listed } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = listed?.users.find((u) => u.email === email);
      if (existing) {
        userRecord = existing;
      } else {
        const { data: created, error } = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { name: email.split("@")[0] },
        });
        if (!error && created.user) {
          userRecord = created.user;
        }
      }
    } catch {
      // Fallback if Supabase admin is in mock/sandbox mode
      userRecord = { id: "demo-user-id", email };
    }

    const response = NextResponse.json({
      success: true,
      user: {
        id: userRecord?.id ?? "demo-user-id",
        email,
      },
    });

    // Set auth cookie
    response.cookies.set("overcast_auth_session", email, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });

    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Authentication failed" },
      { status: 400 }
    );
  }
}
