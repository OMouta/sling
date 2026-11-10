import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useStatus } from "../components/Shell.tsx";
import { Button, ErrorText, Field, Input } from "../components/ui.tsx";
import { authClient } from "../lib/auth.ts";
import { loginRoute } from "../router.tsx";
import { AuthFrame } from "./Setup.tsx";

export function LoginPage() {
  const status = useStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = loginRoute.useSearch();
  const next = search.next ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [step, setStep] = useState<"password" | "2fa">(search.step ?? "password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signedIn = status.data?.signedIn;
  useEffect(() => {
    if (signedIn) void navigate({ href: next, replace: true });
  }, [signedIn, next, navigate]);

  if (status.data?.needsSetup) return <Navigate to="/setup" />;
  if (signedIn) return null;

  async function done() {
    await qc.invalidateQueries({ queryKey: ["status"] });
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

  async function verify(value = code) {
    const clean = value.replace(/\s/g, "");
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    const res = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: clean })
      : await authClient.twoFactor.verifyTotp({ code: clean });
    setBusy(false);
    if (res.error) {
      setCode("");
      return setError(
        backup ? "That backup code didn't work." : "That code didn't match. Try the next one.",
      );
    }
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
      <AuthFrame title={backup ? "Use a backup code" : "Two-factor code"}>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void verify();
          }}
          className="space-y-4"
        >
          <Field label={backup ? "Backup code" : "Code"}>
            <Input
              key={backup ? "backup" : "totp"}
              value={code}
              onChange={(e) => {
                if (backup) return setCode(e.target.value);
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v);
              }}
              inputMode={backup ? "text" : "numeric"}
              autoComplete="one-time-code"
              placeholder={backup ? "xxxxx-xxxxx" : "123456"}
              className="tabular text-center font-mono text-base tracking-[0.3em]"
              autoFocus
              required
            />
          </Field>
          <ErrorText error={error} />
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            Verify
          </Button>
          <button
            type="button"
            onClick={() => {
              setBackup(!backup);
              setCode("");
              setError(null);
            }}
            className="w-full cursor-pointer text-center text-xs text-subtle hover:text-text"
          >
            {backup ? "Use the authenticator app instead" : "Lost your phone? Use a backup code"}
          </button>
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
