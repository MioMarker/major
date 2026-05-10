// Server-only helpers for forwarding the user's Supabase session JWT to
// edge-function calls from server components. Pair with ui/lib/api/* helpers
// that accept an `authToken` parameter — the edge functions verify the JWT.

import { USE_MOCK } from "@/lib/api/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Returns the current user's access token, or null if mock mode is active or
 * Supabase env is unwired. The caller forwards the token to majorFetch via the
 * `authToken` option.
 */
export async function getServerAuthToken(): Promise<string | null> {
  if (USE_MOCK) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
