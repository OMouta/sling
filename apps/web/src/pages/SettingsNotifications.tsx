import {
  DEFAULT_NOTIFICATIONS,
  type NotificationSettings,
  type PushSubscriptionView,
} from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BellRing, Share } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SettingsSection } from "../components/SettingsSection.tsx";
import { Badge, Button, ErrorText, Spinner, Switch } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import {
  deviceLabel,
  devicesKey,
  PushDenied,
  type PushSupport,
  pushSupport,
  removeDevice,
  thisDeviceId,
  turnOnPush,
  usePushDevices,
} from "../lib/notifications.ts";
import { settingsKey } from "../lib/timezone.ts";
import type { Settings } from "../lib/types.ts";

export function NotificationsSection({ settings }: { settings: Settings }) {
  return (
    <SettingsSection id="notifications" title="Notifications">
      <div className="space-y-6 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-6">
        <Devices />
        <Categories notifications={settings.notifications ?? DEFAULT_NOTIFICATIONS} />
      </div>
    </SettingsSection>
  );
}

function Devices() {
  const qc = useQueryClient();
  const devices = usePushDevices();
  const [support, setSupport] = useState<PushSupport>(pushSupport);
  // This browser's device on the server, once known.
  const [mine, setMine] = useState<string | null>(null);
  useEffect(() => {
    thisDeviceId()
      .then(setMine)
      .catch(() => {});
  }, []);
  const list = devices.data ?? [];
  const on = mine !== null && list.some((d) => d.id === mine);
  const label = deviceLabel(navigator.userAgent, navigator.maxTouchPoints);
  const refresh = () => qc.invalidateQueries({ queryKey: devicesKey });

  const turnOn = useMutation({
    mutationFn: turnOnPush,
    onSuccess: (d) => {
      setMine(d.id);
      qc.setQueryData<PushSubscriptionView[]>(devicesKey, (l) =>
        l ? [...l.filter((x) => x.id !== d.id), d] : [d],
      );
      void refresh();
    },
    onError: (err) => {
      if (err instanceof PushDenied) setSupport(pushSupport());
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeDevice(id, id === mine),
    onSuccess: (_r, id) => {
      if (id === mine) setMine(null);
      qc.setQueryData<PushSubscriptionView[]>(devicesKey, (l) => l?.filter((x) => x.id !== id));
      void refresh();
    },
  });

  const status: Record<PushSupport, ReactNode> = {
    ready: label,
    blocked: "Blocked for this site. Allow them in your browser's site settings.",
    insecure: "Push needs HTTPS. Open Sling at its https:// address.",
    unsupported: "This browser can't receive push notifications.",
    "home-screen": "Add Sling to your Home Screen first.",
  };
  const canSwitch = support === "ready" || support === "blocked";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
          <BellRing aria-hidden="true" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            This device
            {on && (
              <Badge tone="ok" dot>
                On
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted">{status[support]}</p>
        </div>
        {canSwitch && (
          <span className="flex shrink-0 items-center gap-2">
            {(turnOn.isPending || remove.isPending) && <Spinner />}
            <Switch
              label="Notifications on this device"
              checked={on}
              disabled={support !== "ready" || turnOn.isPending || remove.isPending}
              onChange={(next) => {
                if (next) turnOn.mutate();
                else if (mine) remove.mutate(mine);
              }}
            />
          </span>
        )}
      </div>
      {support === "home-screen" && <HomeScreenSteps />}
      {list.length > 0 && (
        <ul
          aria-label="Devices"
          className="mt-3 ml-12 divide-y divide-border rounded-xl bg-field shadow-field"
        >
          {list.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              mine={d.id === mine}
              removing={remove.isPending && remove.variables === d.id}
              onRemove={() => remove.mutate(d.id)}
            />
          ))}
        </ul>
      )}
      <div className="mt-2 ml-12">
        <ErrorText error={turnOn.error ?? remove.error} />
      </div>
    </div>
  );
}

function HomeScreenSteps() {
  return (
    <ol className="mt-3 ml-12 space-y-1.5 text-xs leading-[18px] text-muted">
      <li className="flex items-center gap-2">
        <span className="tabular w-3 text-subtle">1.</span>
        <span>
          Tap <Share aria-label="Share" size={13} className="inline align-[-2px] text-icon" /> Share
          in Safari's toolbar.
        </span>
      </li>
      <li className="flex items-center gap-2">
        <span className="tabular w-3 text-subtle">2.</span>
        <span>Choose Add to Home Screen.</span>
      </li>
      <li className="flex items-center gap-2">
        <span className="tabular w-3 text-subtle">3.</span>
        <span>Open Sling from the Home Screen and turn notifications on here.</span>
      </li>
    </ol>
  );
}

function DeviceRow({
  device: d,
  mine,
  removing,
  onRemove,
}: {
  device: PushSubscriptionView;
  mine: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; error: string | null }>("/api/push/test", { id: d.id }),
  });
  let note: ReactNode = d.lastDeliveredAt
    ? `notified ${ago(d.lastDeliveredAt)}`
    : `added ${ago(d.createdAt)}`;
  if (d.lastError) note = <span className="text-danger">The last notification failed.</span>;
  if (test.data) {
    note = test.data.ok ? (
      <span className="text-ok">Sent. Check the device.</span>
    ) : (
      <span className="text-danger">{test.data.error ?? "It didn't arrive."}</span>
    );
  }
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[13px]">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{d.label}</span>
        {mine && <Badge>This device</Badge>}
      </span>
      <span className="text-xs text-subtle" title={d.lastError ?? d.service}>
        {note}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          busy={test.isPending}
          aria-label={`Send a test notification to ${d.label}`}
          onClick={() => test.mutate()}
        >
          Test
        </Button>
        <Button
          size="sm"
          variant="ghost-danger"
          busy={removing}
          aria-label={`Remove ${d.label}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </span>
      {test.error ? (
        <span className="basis-full">
          <ErrorText error={test.error} />
        </span>
      ) : null}
    </li>
  );
}

const CATEGORIES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "approvals", label: "Approvals" },
  { key: "tasks", label: "Finished tasks" },
  { key: "replies", label: "Replies" },
];

function Categories({ notifications }: { notifications: NotificationSettings }) {
  const qc = useQueryClient();
  const set = (n: NotificationSettings) =>
    qc.setQueryData<Settings>(settingsKey, (s) => (s ? { ...s, notifications: n } : s));
  const save = useMutation({
    mutationFn: (patch: Partial<NotificationSettings>) =>
      api.put<NotificationSettings>("/api/settings/notifications", patch),
    // The switch moves at once; the server's answer settles it.
    onMutate: (patch) => set({ ...notifications, ...patch }),
    onSuccess: set,
    onError: () => qc.invalidateQueries({ queryKey: settingsKey }),
  });
  return (
    <div className="space-y-3">
      <p className="text-[13px] font-medium">Notify me about</p>
      <ul className="space-y-3">
        {CATEGORIES.map((c) => (
          <li key={c.key} className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[13px]">{c.label}</p>
            <Switch
              label={c.label}
              checked={notifications[c.key]}
              onChange={(v) => save.mutate({ [c.key]: v })}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-subtle">
        A workflow with a Notify my devices step always reaches you.
      </p>
      <ErrorText error={save.error} />
    </div>
  );
}
