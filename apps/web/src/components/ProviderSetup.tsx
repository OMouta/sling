import type { ModelCatalogView, ModelOption, ProviderModelsView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import {
  findAssistantModel,
  modelsKey,
  shortLabel,
  useModelCatalog,
  useSaveProviderKey,
} from "../lib/models.ts";
import type { ProviderInfo } from "../lib/types.ts";
import { OptionCards } from "./SchemaForm.tsx";
import { Button, Field, Input } from "./ui.tsx";
import { Wizard, type WizardStep } from "./Wizard.tsx";
import { StepNote } from "./WizardBits.tsx";

/** Where each provider hands out API keys. */
const KEY_PAGES: Record<"openai" | "anthropic", { label: string; url: string }> = {
  openai: { label: "platform.openai.com", url: "https://platform.openai.com/api-keys" },
  anthropic: { label: "console.anthropic.com", url: "https://console.anthropic.com/settings/keys" },
};

interface Server {
  id: string;
  label: string;
  detail: string;
  /** Filled in when picked. Docker's name for the host, where Sling's server usually runs. */
  url: string;
  needsKey: boolean;
  keyPage?: { label: string; url: string };
}

const SERVERS: Server[] = [
  {
    id: "ollama",
    label: "Ollama",
    detail: "Models you run yourself, on port 11434.",
    url: "http://host.docker.internal:11434/v1",
    needsKey: false,
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    detail: "Its local server, on port 1234.",
    url: "http://host.docker.internal:1234/v1",
    needsKey: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    detail: "Many providers' models through one key.",
    url: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyPage: { label: "openrouter.ai", url: "https://openrouter.ai/keys" },
  },
  {
    id: "other",
    label: "Another server",
    detail: "Anything with an OpenAI-style API.",
    url: "",
    needsKey: false,
  },
];

const KEEP = "keep";
/** Models shown before Show all, when there are more than a couple more. */
const FIRST = 8;
const CUT_OVER = FIRST + 2;

function validUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return String(err);
}

/**
 * Connects a model provider with an API key, a step at a time: the server
 * for a local or other one, the key with where to make one, then the model
 * new chats start with, from what the key can see. A key whose models can't
 * be listed isn't kept.
 */
export function ProviderSetupDialog({
  provider: p,
  onClose,
}: {
  provider: ProviderInfo;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const saveKey = useSaveProviderKey();
  const catalog = useModelCatalog();
  const compatible = p.id === "openai-compatible";
  const [serverId, setServerId] = useState("");
  const server = SERVERS.find((s) => s.id === serverId);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [found, setFound] = useState<ProviderModelsView | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const current = catalog.data?.defaults.assistant ?? null;
  const currentModel = findAssistantModel(catalog.data, current);
  const keepable = Boolean(current && current.provider !== p.id);
  const models = found?.models ?? [];
  const picked = choice ?? (keepable ? KEEP : (models[0]?.id ?? ""));
  const pickedModel = models.find((m) => m.id === picked);

  // Saves the key and lists its models; one that can't list them is taken back out.
  const check = async (): Promise<boolean> => {
    setProblem(null);
    try {
      const next = await saveKey(p.id, {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(compatible ? { baseUrl: baseUrl.trim() } : {}),
      });
      const entry = next.assistant.find((a) => a.kind === "api" && a.provider === p.id);
      if (entry?.error) {
        setProblem(entry.error);
        const after = await api.del<ModelCatalogView>(`/api/settings/providers/${p.id}`);
        if (after) qc.setQueryData(modelsKey, after);
        void qc.invalidateQueries({ queryKey: ["settings"] });
        return false;
      }
      setFound(entry ?? null);
      setChoice(null);
      return true;
    } catch (err) {
      setProblem(errorText(err));
      return false;
    }
  };

  const setDefault = useMutation({
    mutationFn: (model: ModelOption) =>
      api.put<ModelCatalogView["defaults"]>("/api/settings/chat-defaults", {
        assistant: { provider: p.id, model: model.id, effort: null, fast: false },
      }),
    onSuccess: (defaults) => {
      qc.setQueryData<ModelCatalogView>(modelsKey, (c) => (c ? { ...c, defaults } : c));
      void qc.invalidateQueries({ queryKey: ["sandbox-settings"] });
    },
  });

  // ---------------------------------------------------------------- steps
  const serverStep: WizardStep = {
    id: "server",
    title: "Which server is it?",
    blocked: !server,
    content: (
      <OptionCards
        label="Server"
        options={SERVERS.map((s) => ({ value: s.id, label: s.label, detail: s.detail }))}
        value={serverId}
        onChange={(id) => {
          setServerId(id);
          setBaseUrl(SERVERS.find((s) => s.id === id)?.url ?? "");
          setProblem(null);
        }}
      />
    ),
  };

  const urlTyped = baseUrl.trim() !== "";
  const urlWrong = urlTyped && !validUrl(baseUrl);
  const whereStep: WizardStep = {
    id: "where",
    title: server?.id === "other" ? "Where is it?" : `Where is ${server?.label ?? "it"}?`,
    blocked: !urlTyped || urlWrong || Boolean(server?.needsKey && !apiKey.trim()),
    onNext: check,
    content: (
      <>
        <Field
          label="Address"
          hint={
            urlWrong ? (
              <span className="text-danger">A full address, like http://host:port/v1</span>
            ) : undefined
          }
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            placeholder="http://host.docker.internal:11434/v1"
            aria-invalid={urlWrong || undefined}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setProblem(null);
            }}
          />
        </Field>
        <Field label="API key" hint={server?.needsKey ? undefined : "If the server needs one"}>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setProblem(null);
            }}
          />
        </Field>
        {server?.keyPage && !problem && (
          <StepNote link={{ label: server.keyPage.label, url: server.keyPage.url }}>
            Make one at
          </StepNote>
        )}
        {problem && <StepNote tone="error">{problem}</StepNote>}
      </>
    ),
  };

  const page = compatible ? null : KEY_PAGES[p.id as "openai" | "anthropic"];
  const keyStep: WizardStep = {
    id: "key",
    title: `Paste your ${p.label} API key`,
    blocked: !apiKey.trim(),
    onNext: check,
    content: (
      <>
        <Input
          type="password"
          aria-label={`API key for ${p.label}`}
          autoComplete="off"
          value={apiKey}
          aria-invalid={Boolean(problem) || undefined}
          onChange={(e) => {
            setApiKey(e.target.value);
            setProblem(null);
          }}
        />
        {problem ? (
          <StepNote tone="error">{problem}</StepNote>
        ) : (
          page && <StepNote link={{ label: page.label, url: page.url }}>Make one at</StepNote>
        )}
      </>
    ),
  };

  const cut = !all && models.length > CUT_OVER;
  const shown = cut ? models.slice(0, FIRST) : models;
  const modelStep: WizardStep = {
    id: "model",
    title: "Which model should new chats use?",
    blocked: models.length > 0 && !picked,
    content:
      models.length === 0 ? (
        <StepNote tone="warn">
          {found?.label ?? p.label} didn't list any models.
          {current ? " New chats keep what they use now." : ""}
        </StepNote>
      ) : (
        <>
          <StepNote tone="ok">
            {plural(models.length, "model")} on {compatible ? (server?.label ?? "it") : "this key"}
          </StepNote>
          <OptionCards
            label="Model"
            value={picked}
            onChange={setChoice}
            options={[
              ...(keepable && current
                ? [
                    {
                      value: KEEP,
                      label: `Keep ${shortLabel(currentModel?.label ?? current.model)}`,
                      detail: "What new chats start with now",
                    },
                  ]
                : []),
              ...shown.map((m) => ({
                value: m.id,
                label: m.label,
                detail: m.label !== m.id ? m.id : undefined,
              })),
              // The picked one stays in view when the list is cut short.
              ...(cut && pickedModel && !shown.includes(pickedModel)
                ? [{ value: pickedModel.id, label: pickedModel.label }]
                : []),
            ]}
          />
          {cut && (
            <Button
              size="sm"
              variant="ghost"
              icon={ChevronDown}
              className="-ml-1.5"
              onClick={() => setAll(true)}
            >
              Show all {models.length}
            </Button>
          )}
        </>
      ),
  };

  const steps = compatible ? [serverStep, whereStep, modelStep] : [keyStep, modelStep];
  const name = compatible ? (server?.id === "other" ? "The server" : server?.label) : p.label;

  return (
    <Wizard
      title={compatible ? "Connect a model server" : `Add an ${p.label} API key`}
      steps={steps}
      finishLabel="Finish"
      finishing={setDefault.isPending}
      error={setDefault.error ? errorText(setDefault.error) : null}
      onFinish={async () => {
        if (!pickedModel) return true;
        try {
          await setDefault.mutateAsync(pickedModel);
          return true;
        } catch {
          return false;
        }
      }}
      done={
        <>
          <p className="text-sm font-medium">{name ?? p.label} is connected</p>
          <p className="mt-1 text-xs leading-4 text-muted">
            {plural(models.length, "model")}
            {pickedModel ? ` · New chats use ${shortLabel(pickedModel.label)}` : ""}
          </p>
        </>
      }
      onClose={onClose}
    />
  );
}
