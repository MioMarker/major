"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInWithMagicLink } from "@/lib/auth";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await signInWithMagicLink(email);
        setSent(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      }
    });
  }

  if (sent) {
    return (
      <div className="rounded-md border bg-card p-4 text-sm">
        Magic link sent to <span className="font-mono">{email}</span>. Click the
        link in your email to finish signing in.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input
        type="email"
        required
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Sending…" : "Send magic link"}
      </Button>
    </form>
  );
}
