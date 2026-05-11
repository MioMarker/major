// supabase/functions/major-update-settings/index.ts
//
// POST /major-update-settings
//   body: SettingsPayload
//   200: SettingsPayload (the updated row)
//
// Replaces the operator settings singleton (major.path_blocker_config id=1).
// Records the calling actor in updated_by and stamps updated_at.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

const UpdateSettingsRequest = z.object({
  protected_globs: z.array(z.string()),
  mass_rerank_threshold: z.number().int().min(1),
  shell_pool_size_hint: z.number().int().min(0),
  auto_triage_enabled: z.boolean(),
  auto_triage_on_new_briefs: z.boolean(),
});

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const parsed = UpdateSettingsRequest.safeParse(await req.json());
    if (!parsed.success) return errorResponse(parsed.error.message, 400);

    const { data, error } = await auth.client
      .from("path_blocker_config")
      .update({
        protected_globs: parsed.data.protected_globs,
        mass_rerank_threshold: parsed.data.mass_rerank_threshold,
        shell_pool_size_hint: parsed.data.shell_pool_size_hint,
        auto_triage_enabled: parsed.data.auto_triage_enabled,
        auto_triage_on_new_briefs: parsed.data.auto_triage_on_new_briefs,
        updated_at: new Date().toISOString(),
        updated_by: auth.actor,
      })
      .eq("id", 1)
      .select(
        "protected_globs, mass_rerank_threshold, shell_pool_size_hint, auto_triage_enabled, auto_triage_on_new_briefs",
      )
      .single();

    if (error) {
      console.error("[major-update-settings] update failed:", error);
      return errorResponse(error.message, 500);
    }
    if (!data) {
      return errorResponse("Settings not found", 404);
    }

    return jsonResponse({
      protected_globs: data.protected_globs,
      mass_rerank_threshold: data.mass_rerank_threshold,
      shell_pool_size_hint: data.shell_pool_size_hint,
      auto_triage_enabled: data.auto_triage_enabled,
      auto_triage_on_new_briefs: data.auto_triage_on_new_briefs,
    });
  } catch (err) {
    console.error("[major-update-settings]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
