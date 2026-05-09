// supabase/functions/_shared/auth.ts
//
// Authentication helper for Major's edge functions. Two caller types:
//
//   1. Human users (UI): Authorization: Bearer <user-JWT> → validated via
//      `supabase.auth.getUser(token)`. Works with HS256 and ES256.
//
//   2. Internal callers (Runner): Authorization: Bearer <service-role-key>
//      + X-Major-Runner-Id: <runner-id>. Bypasses the user check because no
//      `auth.users` row exists for runners; attribution is by runner_id.
//      The service-role bypass is intentionally simple — it requires the
//      X-Major-Runner-Id header so attribution is never ambiguous.
//
// Returns a discriminated union so callers branch with `if (!auth.ok)`
// instead of null-checking each field. `kind` distinguishes 'human' vs
// 'runner'; `user` and `userId` are null for runner callers.

import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

// The client targets the `major` schema by default. We widen the schema
// generic to `any` so callers (and helpers) don't have to thread the
// `"major"` literal through every signature.
// deno-lint-ignore no-explicit-any
export type MajorClient = SupabaseClient<any, any, any>;

export type AuthenticateResult =
  | {
      ok: true;
      kind: "human" | "runner";
      client: MajorClient;
      user: User | null; // null when kind === "runner"
      userId: string | null; // null when kind === "runner"
      actor: string; // "human:<email-local>" or "runner:<runner-id>"
    }
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

  // Service-role bypass: runner callers send the project's service role key
  // as the bearer token plus an X-Major-Runner-Id header. Skip the user
  // validation (no auth.users row exists for runners) and return a runner
  // caller success with attribution = runner:<id>.
  if (token === serviceKey) {
    const runnerId = req.headers.get("X-Major-Runner-Id")?.trim();
    if (!runnerId) {
      return {
        ok: false,
        status: 401,
        message: "Service-role caller must set X-Major-Runner-Id",
      };
    }
    return {
      ok: true,
      kind: "runner",
      client,
      user: null,
      userId: null,
      actor: `runner:${runnerId}`,
    };
  }

  // User JWT path
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

  return { ok: true, kind: "human", client, user, userId: user.id, actor };
}
