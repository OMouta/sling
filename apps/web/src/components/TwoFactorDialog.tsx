import { Check, Copy, Download, KeyRound, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { ApiError, api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { Button, Dialog, ErrorText, Field, Input, Spinner } from "./ui.tsx";

interface Setup {
  totpURI: string;
  backupCodes: string[];
}

type Step =
  | { kind: "starting" }
  | { kind: "confirm" }
  | { kind: "scan"; setup: Setup }
  | { kind: "codes"; setup: Setup };

const needsConfirm = (err: unknown) => err instanceof ApiError && err.status === 403;

/**
 * Turns an authenticator app on, or off. Right after signing in it needs
 * nothing else; later it asks for a password or a passkey first.
 */
export function TwoFactorDialog({
  action,
  email,
  onClose,
  onDone,
}: {
  action: "enable" | "disable";
  email: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "starting" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function fresh() {
    setError(null);
    try {
      if (action === "enable") {
        const setup = await api.post<Setup>("/api/auth/two-factor/enable-fresh");
        setStep({ kind: "scan", setup });
      } else {
        await api.post("/api/auth/two-factor/disable-fresh");
        onDone();
        onClose();
      }
    } catch (err) {
      if (needsConfirm(err)) setStep({ kind: "confirm" });
      else {
        setError(err);
        setStep({ kind: "confirm" });
      }
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: try once when the dialog opens.
  useEffect(() => {
    void fresh();
  }, []);

  async function withPassword(password: string) {
    setBusy(true);
    setError(null);
    try {
      if (action === "disable") {
        await api.post("/api/auth/two-factor/disable", { password });
        onDone();
        onClose();
        return;
      }
      const setup = await api.post<Setup>("/api/auth/two-factor/enable", { password });
      setStep({ kind: "scan", setup });
    } catch (err) {
      setError(err instanceof ApiError && err.status < 500 ? "That password didn't work." : err);
    } finally {
      setBusy(false);
    }
  }

  async function withPasskey() {
    setBusy(true);
    setError(null);
    // Signing in again with a passkey makes the session recent.
    const res = await authClient.signIn.passkey();
    setBusy(false);
    if (res?.error) return setError(res.error.message ?? "The passkey didn't work.");
    await fresh();
  }

  const title =
    action === "disable"
      ? "Turn off the authenticator app"
      : step.kind === "codes"
        ? "Save your backup codes"
        : "Set up an authenticator app";

  return (
    <Dialog
      title={title}
      description={
        step.kind === "confirm"
          ? "Confirm it's you first."
          : step.kind === "scan"
            ? "Scan the QR code with any authenticator app."
            : step.kind === "codes"
              ? "You won't see them again."
              : undefined
      }
      onClose={onClose}
    >
      {step.kind === "starting" && (
        <div className="grid place-items-center py-8">
          <Spinner className="size-5" />
        </div>
      )}
      {step.kind === "confirm" && (
        <Confirm email={email} busy={busy} onPassword={withPassword} onPasskey={withPasskey} />
      )}
      {step.kind === "scan" && (
        <Scan setup={step.setup} onVerified={() => setStep({ kind: "codes", setup: step.setup })} />
      )}
      {step.kind === "codes" && (
        <Codes
          codes={step.setup.backupCodes}
          onDone={() => {
            onDone();
            onClose();
          }}
        />
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

function Confirm({
  email,
  busy,
  onPassword,
  onPasskey,
}: {
  email: string;
  busy: boolean;
  onPassword: (password: string) => void;
  onPasskey: () => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (password) onPassword(password);
      }}
    >
      {/* Lets a password manager match the saved login. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <Field label="Password">
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={busy} disabled={!password}>
          Continue
        </Button>
        <Button icon={KeyRound} onClick={onPasskey} disabled={busy}>
          Use a passkey instead
        </Button>
      </div>
    </form>
  );
}

function Scan({ setup, onVerified }: { setup: Setup; onVerified: () => void }) {
  const svg = useMemo(
    () => renderSVG(setup.totpURI, { pixelSize: 5, whiteColor: "#ffffff", blackColor: "#111113" }),
    [setup.totpURI],
  );
  const secret = new URL(setup.totpURI).searchParams.get("secret") ?? "";
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function verify(value: string) {
    setBusy(true);
    setError(null);
    const ok = await api
      .post("/api/auth/two-factor/verify-totp", { code: value })
      .then(() => true)
      .catch(() => false);
    setBusy(false);
    if (!ok) {
      setError("That code didn't match. Check the time on your phone and try the next one.");
      setCode("");
      input.current?.focus();
      return;
    }
    onVerified();
  }

  return (
    <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
      <div
        className="size-[184px] overflow-hidden rounded-xl bg-white p-2 shadow-card [&>svg]:size-full"
        role="img"
        aria-label="QR code for your authenticator app"
        // Generated locally from the setup URI.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG built by uqr from our own data.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="min-w-0 space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-soft">Can't scan it? Enter this key</p>
          <div className="flex items-center gap-2 rounded-lg bg-field py-1 pr-1 pl-3 shadow-field">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-soft">{secret}</code>
            <Button
              size="sm"
              variant="ghost"
              icon={copied ? Check : Copy}
              onClick={async () => {
                await navigator.clipboard.writeText(secret);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <Field label="Then enter the 6-digit code it shows">
          <Input
            ref={input}
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            aria-invalid={Boolean(error)}
            className="tabular h-10 max-w-44 text-center font-mono text-base tracking-[0.3em]"
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(v);
              if (v.length === 6) void verify(v);
            }}
          />
        </Field>
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="size-3.5" /> Checking
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl bg-field p-4 font-mono text-[13px] text-soft shadow-field">
        {codes.map((c) => (
          <li key={c} className="tabular">
            {c}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon={copied ? Check : Copy}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy all"}
        </Button>
        <Button
          icon={Download}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "sling-backup-codes.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </Button>
        <Button variant="primary" icon={ShieldCheck} className="ml-auto" onClick={onDone}>
          I've saved them
        </Button>
      </div>
    </div>
  );
}
