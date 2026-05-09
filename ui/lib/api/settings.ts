import { MOCK_SETTINGS } from "@/lib/mock/settings";
import type { SettingsPayload } from "@/lib/types";
import { USE_MOCK, majorFetch } from "@/lib/api/client";

export async function getSettings(authToken?: string): Promise<SettingsPayload> {
  if (USE_MOCK) {
    return MOCK_SETTINGS;
  }
  return majorFetch<SettingsPayload>("major-get-settings", { authToken });
}

export async function updateSettings(
  next: SettingsPayload,
  authToken?: string,
): Promise<SettingsPayload> {
  if (USE_MOCK) {
    Object.assign(MOCK_SETTINGS, next);
    return MOCK_SETTINGS;
  }
  return majorFetch<SettingsPayload>("major-update-settings", {
    method: "POST",
    body: next,
    authToken,
  });
}
