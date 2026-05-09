import { AppShell } from "@/components/app-shell";
import { getSettings } from "@/lib/api/settings";
import { SettingsForm } from "./_form";

export default async function SettingsPage() {
  const settings = await getSettings();
  return (
    <AppShell active="/settings">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Path-blocker configuration, mass-rerank threshold, Shell pool hint, and
          auto-triage policy toggles.
        </p>
      </div>
      <SettingsForm settings={settings} />
    </AppShell>
  );
}
