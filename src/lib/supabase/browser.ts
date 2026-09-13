"use client";

import { createClient } from "@supabase/supabase-js";

/** Browser-safe client: it uses only the publishable project key. */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase browser configuration is missing");
  return createClient(url, key);
}
