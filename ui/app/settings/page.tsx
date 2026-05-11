import { AppShell } from "@/components/app-shell";
import { getSettings } from "@/lib/api/settings";
import { getServerAuthToken } from "@/lib/auth-server";
import { SettingsForm } from "./_form";

export default async function SettingsPage() {
  const authToken = await getServerAuthToken();
  const settings = await getSettings(authToken ?? undefined);
  return (
    <AppShell active="/settings">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Auto-triage policy and advanced configuration.
        </p>
      </div>
      <SettingsForm settings={settings} />
    </AppShell>
  );
}
