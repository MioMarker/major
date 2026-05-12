// supabase/functions/major-quick-start/index.ts
//
// POST /major-quick-start
//   body: (none)
//   200:  { triaged: number, readyForAgent: number }
//
// Finds all briefs with status='ready-for-triage'. For each, creates a triage
// session and immediately transitions the brief to 'ready-for-agent' if
// auto_triage_enabled is set in the path_blocker_config settings, otherwise
// transitions to 'needs-info'. Uses the service-role client for all writes
// since this is a Cyberbrain-level batch action.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return errorResponse("Server misconfiguration", 500);
    }

    // Use the service-role client for writes; this is a Cyberbrain batch action.
    const serviceClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "major" },
    });

    // Load settings to check auto_triage_enabled.
    const { data: settings } = await serviceClient
      .from("path_blocker_config")
      .select("auto_triage_enabled")
      .eq("id", 1)
      .single();

    const autoTriageEnabled = settings?.auto_triage_enabled === true;

    // Fetch all ready-for-triage briefs.
    const { data: briefs, error: briefsErr } = await serviceClient
      .from("briefs")
      .select("id")
      .eq("status", "ready-for-triage");

    if (briefsErr) {
      console.error("[MajorQuickStart] briefs fetch failed:", briefsErr);
      return errorResponse("Internal server error", 500);
    }

    let triaged = 0;
    let readyForAgent = 0;

    for (const brief of briefs ?? []) {
      // Create a triage session for this brief.
      const { error: sessionErr } = await serviceClient
        .from("triage_sessions")
        .insert({
          initiator_actor: auth.actor,
          status: "open",
          transcript: [],
          entry_point: "quick-start",
          trigger_payload: { brief_id: brief.id },
        });

      if (sessionErr) {
        console.error(
          `[MajorQuickStart] session insert failed for brief ${brief.id}:`,
          sessionErr,
        );
        continue;
      }

      const nextStatus = autoTriageEnabled ? "ready-for-agent" : "needs-info";
      const { error: updateErr } = await serviceClient
        .from("briefs")
        .update({ status: nextStatus })
        .eq("id", brief.id)
        .eq("status", "ready-for-triage");

      if (updateErr) {
        console.error(
          `[MajorQuickStart] brief update failed for brief ${brief.id}:`,
          updateErr,
        );
        continue;
      }

      triaged++;
      if (autoTriageEnabled) readyForAgent++;
    }

    console.log(
      `[MajorQuickStart] triaged=${triaged} readyForAgent=${readyForAgent}`,
    );
    return jsonResponse({ triaged, readyForAgent });
  } catch (err) {
    console.error("[MajorQuickStart]", err);
    return errorResponse("Internal server error", 500);
  }
});
