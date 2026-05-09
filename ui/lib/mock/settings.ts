import type { SettingsPayload } from "@/lib/types";

export const MOCK_SETTINGS: SettingsPayload = {
  protected_globs: [
    "supabase/functions/chat-with-ai/**",
    "eval/**",
    "supabase/migrations/**",
    ".claude/rules/**",
    "app.config.ts",
  ],
  mass_rerank_threshold: 5,
  shell_pool_size_hint: 2,
  auto_triage_enabled: true,
  auto_triage_on_new_briefs: false,
};
