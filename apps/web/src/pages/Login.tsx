import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useStatus } from "../components/Shell.tsx";
import { Button, ErrorText, Field, Input } from "../components/ui.tsx";
import { authClient } from "../lib/auth.ts";
import { AuthFrame } from "./Setup.tsx";

export function LoginPage() {
  const status = useStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"password" | "2fa">(
    new URLSearchParams(location.search).get("step") === "2fa" ? "2fa" : "password",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status.data?.needsSetup) return <Navigate to="/setup" />;
  if (status.data?.signedIn) return <Navigate to="/" />;

  async function done() {
    await qc.invalidateQueries({ queryKey: ["status"] });
    void navigate({ to: "/" });
  }

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "Sign-in failed.");
    if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setStep("2fa");
      return;
    }
    await done();
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "That code didn't work.");
    await done();
  }

  async function passkey() {
    setError(null);
    const res = await authClient.signIn.passkey();
    if (res?.error) return setError(res.error.message ?? "Passkey sign-in failed.");
    await done();
  }

  if (step === "2fa") {
    return (
      <AuthFrame
        title="Two-factor code"
        subtitle="Enter the 6-digit code from your authenticator app."
      >
        <form onSubmit={verify} className="space-y-4">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            Verify
          </Button>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign in to Sling">
      <form onSubmit={signIn} className="space-y-4">
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username webauthn"
            required
            autoFocus
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          Sign in
        </Button>
        <div className="flex items-center gap-3 text-xs text-subtle">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
        <Button className="w-full" icon={KeyRound} onClick={passkey}>
          Use a passkey
        </Button>
      </form>
    </AuthFrame>
  );
}
