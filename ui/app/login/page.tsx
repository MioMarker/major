import { LoginForm } from "./_form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Major</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in via email magic link.
          </p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
