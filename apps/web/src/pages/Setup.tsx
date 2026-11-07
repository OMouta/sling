import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { useStatus } from "../components/Shell.tsx";
import { Button, Card, ErrorText, Field, Input } from "../components/ui.tsx";
import { authClient } from "../lib/auth.ts";

export function SetupPage() {
  const status = useStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status.data && !status.data.needsSetup) return <Navigate to="/" />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Could not create the account.");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["status"] });
    void navigate({ to: "/" });
  }

  return (
    <AuthFrame title="Set up Sling">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint="At least 10 characters">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            required
            autoComplete="new-password"
          />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}

export function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  const status = useStatus();
  // Cookies, passkeys, and the server's origin check all belong to one address.
  const home = status.data?.publicUrl;
  const elsewhere = home !== undefined && home !== window.location.origin;
  const target = elsewhere ? new URL(window.location.pathname, home) : null;
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-48 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-accent opacity-[0.14] blur-[120px]"
      />
      <div className="relative w-full max-w-[360px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-accent text-white shadow-primary">
            <Logo className="size-6" />
          </span>
          <h1 className="mt-4 text-xl font-medium tracking-tight">
            {target ? "Open Sling at its address" : title}
          </h1>
          {target && (
            <p className="mt-1.5 text-[13px] leading-5 text-pretty text-muted">
              Sign-in only works at {target.host}.
            </p>
          )}
        </div>
        <Card className="p-5 [&_button]:h-9 [&_input]:h-9">
          {target ? (
            <div className="space-y-3">
              <a
                href={target.toString()}
                className="pressable flex h-9 w-full items-center justify-center rounded-full bg-accent text-xs font-medium text-accent-fg shadow-primary"
              >
                Go to {target.host}
              </a>
              <p className="text-xs leading-4 text-subtle">
                To use this address, run deploy/setup.sh again.
              </p>
            </div>
          ) : (
            children
          )}
        </Card>
      </div>
    </div>
  );
}
