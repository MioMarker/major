import Link from "next/link";
import type { ReactNode } from "react";
import { USE_MOCK } from "@/lib/api/client";
import { cn } from "@/lib/utils";

const NAV: Array<{ href: string; label: string }> = [
  { href: "/", label: "Briefs" },
  { href: "/triage", label: "Triage" },
  { href: "/qa", label: "Pending QA" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({
  children,
  active,
}: {
  children: ReactNode;
  active: string;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-base font-semibold tracking-tight">
              Major
            </Link>
            <nav className="flex items-center gap-1">
              {NAV.map((entry) => (
                <Link
                  key={entry.href}
                  href={entry.href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                    active === entry.href &&
                      "bg-accent text-foreground",
                  )}
                >
                  {entry.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="text-xs text-muted-foreground">
            staging · {USE_MOCK ? "mock-mode" : "live"}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
