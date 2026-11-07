import { isPermissionMode, MODEL_PROVIDER_IDS, newId, PERMISSION_MODES } from "@sling/core";
import { schema } from "@sling/db";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { clearModelCache, modelCatalog } from "../agent/catalog.ts";
import { ChatSettingsPatch } from "../agent/chat-settings.ts";
import {
  defaultModelConfig,
  MODEL_PROVIDERS,
  providerConfig,
  resolveModel,
} from "../agent/models.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { encryptSecret, SECRET_KEY_VERSION } from "../crypto.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { notificationSettings } from "../push/payloads.ts";
import {
  NotificationsPatch,
  SettingsInputError,
  setChatDefaults,
  setDefaultMode,
  setNotifications,
  setTimeZone,
} from "../settings.ts";

const ModelInput = z.object({
  provider: z.enum(["openai", "anthropic", "openai-compatible"]),
  model: z.string().min(1).max(200),
  baseUrl: z.url().nullish(),
  /** Omit to keep the stored key. */
  apiKey: z.string().min(1).max(500).optional(),
});

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get("/api/settings", async (request) => {
    const actor = actorOf(request);
    const [ws] = await ctx.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, actor.workspaceId));
    const cfg = await defaultModelConfig(ctx, actor.workspaceId);
    const [member] = await ctx.db
      .select({ notifications: schema.workspaceMembers.notifications })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, actor.workspaceId),
          eq(schema.workspaceMembers.userId, actor.userId),
        ),
      );
    return {
      defaultMode: ws?.defaultMode ?? "auto",
      modes: PERMISSION_MODES,
      /** Null until set; the web app sets it from the browser then. */
      timeZone: ws?.timeZone ?? null,
      /** The signed-in user's push categories. */
      notifications: notificationSettings(member?.notifications),
      providers: await Promise.all(
        Object.values(MODEL_PROVIDERS).map(async (p) => {
          const c = await providerConfig(ctx, actor.workspaceId, p.id);
          return {
            id: p.id,
            label: p.label,
            needsBaseUrl: p.needsBaseUrl,
            defaultModel: p.defaultModel,
            hasKey: Boolean(c?.credentialId),
            baseUrl: c?.baseUrl ?? null,
            connected: Boolean(c && (c.credentialId || (p.needsBaseUrl && c.baseUrl))),
          };
        }),
      ),
      model: cfg
        ? {
            provider: cfg.provider,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            hasKey: cfg.credentialId !== null,
          }
        : null,
    };
  });

  r.put(
    "/api/settings/mode",
    { schema: { body: z.object({ defaultMode: z.enum(PERMISSION_MODES) }) } },
    async (request) => {
      const mode = request.body.defaultMode;
      if (!isPermissionMode(mode)) throw new Error("bad mode");
      await setDefaultMode(ctx, actorOf(request), mode);
      return { ok: true };
    },
  );

  r.put(
    "/api/settings/time-zone",
    { schema: { body: z.object({ timeZone: z.string().min(1).max(64) }) } },
    async (request, reply) => {
      try {
        await setTimeZone(ctx, actorOf(request), request.body.timeZone);
      } catch (err) {
        if (err instanceof SettingsInputError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      return { ok: true };
    },
  );

  /** Which pushes the signed-in user gets. Categories left out keep their setting. */
  r.put("/api/settings/notifications", { schema: { body: NotificationsPatch } }, async (request) =>
    setNotifications(ctx, actorOf(request), request.body),
  );

  r.put("/api/settings/model", { schema: { body: ModelInput } }, async (request, reply) => {
    const actor = actorOf(request);
    const body = request.body;
    const provider = MODEL_PROVIDERS[body.provider];
    if (provider.needsBaseUrl && !body.baseUrl) {
      return reply.code(400).send({ error: "This provider needs a base URL." });
    }
    const existing = await defaultModelConfig(ctx, actor.workspaceId);
    await ctx.db.transaction(async (tx) => {
      let credentialId = existing?.credentialId ?? null;
      if (body.apiKey) {
        const ciphertext = encryptSecret(ctx.secretsKey, body.apiKey);
        if (credentialId) {
          await tx
            .update(schema.credentials)
            .set({ ciphertext, keyVersion: SECRET_KEY_VERSION })
            .where(
              and(
                eq(schema.credentials.id, credentialId),
                eq(schema.credentials.workspaceId, actor.workspaceId),
              ),
            );
        } else {
          credentialId = newId("crd");
          await tx.insert(schema.credentials).values({
            id: credentialId,
            workspaceId: actor.workspaceId,
            ownerId: actor.userId,
            kind: "model_api_key",
            ciphertext,
            keyVersion: SECRET_KEY_VERSION,
          });
        }
      }
      const values = {
        provider: body.provider,
        model: body.model,
        baseUrl: body.baseUrl ?? null,
        credentialId,
      };
      if (existing) {
        await tx
          .update(schema.modelConfigs)
          .set(values)
          .where(eq(schema.modelConfigs.id, existing.id));
      } else {
        await tx.insert(schema.modelConfigs).values({
          id: newId("mdl"),
          workspaceId: actor.workspaceId,
          ownerId: actor.userId,
          isDefault: true,
          ...values,
        });
      }
    });
    await audit(ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "settings.model_changed",
      subjectType: "workspace",
      subjectId: actor.workspaceId,
      details: { provider: body.provider, model: body.model, keyChanged: Boolean(body.apiKey) },
    });
    return { ok: true };
  });

  r.get("/api/models", async (request) => modelCatalog(ctx, actorOf(request).workspaceId));

  /**
   * Stores or replaces one provider's API key (and base URL). Each provider
   * keeps its own key, so conversations can switch between them.
   */
  r.put(
    "/api/settings/providers/:provider",
    {
      schema: {
        params: z.object({ provider: z.enum(MODEL_PROVIDER_IDS) }),
        body: z.object({
          apiKey: z.string().trim().min(1).max(500).optional(),
          baseUrl: z.url().nullish(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { provider } = request.params;
      const info = MODEL_PROVIDERS[provider];
      const existing = await providerConfig(ctx, actor.workspaceId, provider);
      const baseUrl =
        request.body.baseUrl !== undefined ? request.body.baseUrl : (existing?.baseUrl ?? null);
      if (info.needsBaseUrl && !baseUrl) {
        return reply.code(400).send({ error: "This provider needs a base URL." });
      }
      if (!existing && !request.body.apiKey && !info.needsBaseUrl) {
        return reply.code(400).send({ error: "Paste an API key." });
      }
      const hasDefault = Boolean(await defaultModelConfig(ctx, actor.workspaceId));
      await ctx.db.transaction(async (tx) => {
        let credentialId = existing?.credentialId ?? null;
        if (request.body.apiKey) {
          const ciphertext = encryptSecret(ctx.secretsKey, request.body.apiKey);
          if (credentialId) {
            await tx
              .update(schema.credentials)
              .set({ ciphertext, keyVersion: SECRET_KEY_VERSION })
              .where(
                and(
                  eq(schema.credentials.id, credentialId),
                  eq(schema.credentials.workspaceId, actor.workspaceId),
                ),
              );
          } else {
            credentialId = newId("crd");
            await tx.insert(schema.credentials).values({
              id: credentialId,
              workspaceId: actor.workspaceId,
              ownerId: actor.userId,
              kind: "model_api_key",
              ciphertext,
              keyVersion: SECRET_KEY_VERSION,
            });
          }
        }
        if (existing) {
          await tx
            .update(schema.modelConfigs)
            .set({ credentialId, baseUrl })
            .where(eq(schema.modelConfigs.id, existing.id));
        } else {
          await tx.insert(schema.modelConfigs).values({
            id: newId("mdl"),
            workspaceId: actor.workspaceId,
            ownerId: actor.userId,
            provider,
            model: info.defaultModel,
            baseUrl,
            credentialId,
            isDefault: !hasDefault,
          });
        }
      });
      clearModelCache(actor.workspaceId);
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "settings.provider_saved",
        subjectType: "workspace",
        subjectId: actor.workspaceId,
        details: { provider, keyChanged: Boolean(request.body.apiKey) },
      });
      return modelCatalog(ctx, actor.workspaceId);
    },
  );

  r.delete(
    "/api/settings/providers/:provider",
    { schema: { params: z.object({ provider: z.enum(MODEL_PROVIDER_IDS) }) } },
    async (request) => {
      const actor = actorOf(request);
      const { provider } = request.params;
      const existing = await providerConfig(ctx, actor.workspaceId, provider);
      if (existing) {
        await ctx.db.transaction(async (tx) => {
          await tx.delete(schema.modelConfigs).where(eq(schema.modelConfigs.id, existing.id));
          if (existing.credentialId) {
            await tx
              .delete(schema.credentials)
              .where(
                and(
                  eq(schema.credentials.id, existing.credentialId),
                  eq(schema.credentials.workspaceId, actor.workspaceId),
                ),
              );
          }
          if (existing.isDefault) {
            const [next] = await tx
              .select({ id: schema.modelConfigs.id })
              .from(schema.modelConfigs)
              .where(eq(schema.modelConfigs.workspaceId, actor.workspaceId))
              .limit(1);
            if (next) {
              await tx
                .update(schema.modelConfigs)
                .set({ isDefault: true })
                .where(eq(schema.modelConfigs.id, next.id));
            }
          }
        });
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: "settings.provider_removed",
          subjectType: "workspace",
          subjectId: actor.workspaceId,
          details: { provider },
        });
      }
      clearModelCache(actor.workspaceId);
      return modelCatalog(ctx, actor.workspaceId);
    },
  );

  /** Checks a provider's key by listing its models. */
  r.post(
    "/api/settings/providers/:provider/test",
    { schema: { params: z.object({ provider: z.enum(MODEL_PROVIDER_IDS) }) } },
    async (request) => {
      const actor = actorOf(request);
      clearModelCache(actor.workspaceId);
      const started = Date.now();
      const catalog = await modelCatalog(ctx, actor.workspaceId);
      const p = catalog.assistant.find((x) => x.provider === request.params.provider);
      if (!p?.connected) return { ok: false, error: "No key is stored for this provider." };
      if (p.error) return { ok: false, error: p.error };
      return { ok: true, models: p.models.length, ms: Date.now() - started };
    },
  );

  /** What new conversations start with. */
  r.put("/api/settings/chat-defaults", { schema: { body: ChatSettingsPatch } }, async (request) =>
    setChatDefaults(ctx, actorOf(request), request.body),
  );

  r.post("/api/settings/model/test", async (request) => {
    const actor = actorOf(request);
    const started = Date.now();
    try {
      const model = await resolveModel(ctx, actor.workspaceId);
      const result = await generateText({
        model,
        prompt: "Reply with the single word OK.",
        maxOutputTokens: 16,
      });
      return { ok: true, reply: result.text.slice(0, 100), ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
