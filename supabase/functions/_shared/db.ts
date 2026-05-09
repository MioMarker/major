// supabase/functions/_shared/db.ts
//
// Service-role Supabase client builder. Major's edge functions almost always
// need to bypass RLS — they ARE the privileged surface in front of the DB.
// Caller-side authorization happens in `auth.ts` (user-facing) or via webhook
// signature (GitHub) before this client is used.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Schema generic widened to `any` because the schema-typed default of
// SupabaseClient is `"public"` and this client targets `major`.
// deno-lint-ignore no-explicit-any
export type MajorClient = SupabaseClient<any, any, any>;

export function getAdminClient(): MajorClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in edge function env",
    );
  }
  const client: MajorClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "major" },
  });
  return client;
}

// Same client without a default schema. Use this when you need cross-schema
// access (e.g., reading auth.users) or are calling RPCs in `public`.
export function getRawAdminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in edge function env",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
