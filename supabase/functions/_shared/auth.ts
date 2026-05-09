// supabase/functions/_shared/auth.ts
//
// User authentication helper. Verifies a Supabase JWT from the Authorization
// header, returns a service-role admin client (with the `major` schema as
// default) plus the validated user. Token validation goes through
// `supabase.auth.getUser(token)` so it works with both HS256 and ES256
// configurations.
//
// Returns a discriminated union so callers branch with `if (!auth.ok)`
// instead of null-checking each field.

import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

// The client targets the `major` schema by default. We widen the schema
// generic to `any` so callers (and helpers) don't have to thread the
// `"major"` literal through every signature.
// deno-lint-ignore no-explicit-any
export type MajorClient = SupabaseClient<any, any, any>;

export type AuthenticateResult =
  | { ok: true; client: MajorClient; user: User; userId: string; actor: string }
  | { ok: false; status: number; message: string };

export async function authenticate(req: Request): Promise<AuthenticateResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return { ok: false, status: 500, message: "Server misconfiguration" };
  }

  // Service-role client; targets the `major` schema by default. We still
  // validate the user's token explicitly via `auth.getUser(token)` — never
  // trust the JWT signature checked by the gateway alone.
  const client: MajorClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "major" },
  });

  const token = authHeader.slice("Bearer ".length);

  let result;
  try {
    result = await client.auth.getUser(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[auth] getUser threw:", msg);
    return { ok: false, status: 401, message: "Token validation failed" };
  }

  const user = result?.data?.user ?? null;
  if (result?.error || !user) {
    const msg = result?.error?.message ?? "no user returned";
    console.error("[auth] getUser rejected:", msg);
    return { ok: false, status: 401, message: "Invalid or expired token" };
  }

  // Build a stable actor string for Event attribution. Prefer the email's
  // local part (e.g., 'human:jonathan'); fall back to user id.
  const email = user.email ?? "";
  const localPart = email.split("@")[0] || user.id;
  const actor = `human:${localPart}`;

  return { ok: true, client, user, userId: user.id, actor };
}
