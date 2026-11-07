import type { PermissionMode } from "@sling/core";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button, Dialog } from "./ui.tsx";

/**
 * Wraps a mode change: Full access asks first, in a dialog, because it turns
 * off the agent's sandbox and every approval.
 */
export function useModeChange(apply: (mode: PermissionMode) => void) {
  const [asking, setAsking] = useState(false);
  const change = (mode: PermissionMode) => {
    if (mode === "full-access") setAsking(true);
    else apply(mode);
  };
  const dialog = asking ? (
    <Dialog
      title="Switch to Full access?"
      onClose={() => setAsking(false)}
      footer={
        <>
          <Button onClick={() => setAsking(false)} data-autofocus>
            Keep the current mode
          </Button>
          <Button
            variant="danger"
            icon={ShieldAlert}
            onClick={() => {
              setAsking(false);
              apply("full-access");
            }}
          >
            Switch to Full access
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-5 text-soft">
        The agent runs without its sandbox, and nothing asks before a push, PR, merge or deploy.
      </p>
    </Dialog>
  ) : null;
  return { change, dialog };
}
