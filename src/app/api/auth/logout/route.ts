import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  response.cookies.delete("overcast_auth_session");
  return response;
}
