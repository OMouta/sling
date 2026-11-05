import { isPermissionMode, newId, PERMISSION_MODES } from "@sling/core";
import { schema } from "@sling/db";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { defaultModelConfig, MODEL_PROVIDERS, resolveModel } from "../agent/models.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { encryptSecret, SECRET_KEY_VERSION } from "../crypto.ts";
import { actorOf, requireActor } from "../http/session.ts";

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
    return {
      defaultMode: ws?.defaultMode ?? "auto",
      modes: PERMISSION_MODES,
      providers: Object.values(MODEL_PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        needsBaseUrl: p.needsBaseUrl,
        defaultModel: p.defaultModel,
      })),
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
      const actor = actorOf(request);
      const mode = request.body.defaultMode;
      if (!isPermissionMode(mode)) throw new Error("bad mode");
      await ctx.db
        .update(schema.workspaces)
        .set({ defaultMode: mode })
        .where(eq(schema.workspaces.id, actor.workspaceId));
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "settings.default_mode_changed",
        subjectType: "workspace",
        subjectId: actor.workspaceId,
        details: { mode },
      });
      return { ok: true };
    },
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
