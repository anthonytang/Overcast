import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = request.cookies.get("overcast_auth_session")?.value;
  if (!session) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({
    user: {
      email: session,
      name: session.split("@")[0],
    },
  });
}
