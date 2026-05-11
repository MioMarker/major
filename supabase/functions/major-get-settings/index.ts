// supabase/functions/major-get-settings/index.ts
//
// GET /major-get-settings
//   200: SettingsPayload
//
// Returns the operator settings singleton (major.path_blocker_config id=1).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const { data, error } = await auth.client
      .from("path_blocker_config")
      .select(
        "protected_globs, mass_rerank_threshold, shell_pool_size_hint, auto_triage_enabled, auto_triage_on_new_briefs, ai_provider",
      )
      .eq("id", 1)
      .single();

    if (error) {
      console.error("[major-get-settings] query failed:", error);
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
      ai_provider: data.ai_provider ?? "openai",
    });
  } catch (err) {
    console.error("[major-get-settings]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
