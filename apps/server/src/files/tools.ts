import { tool } from "ai";
import { z } from "zod";
import type { ToolScope } from "../agent/tools.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { FileError } from "./service.ts";

interface CallOptions {
  abortSignal?: AbortSignal;
}

/** search_files and read_file. Reading never asks, and Read-only allows it. */
export function fileTools(ctx: AppContext, scope: ToolScope) {
  return {
    search_files: tool({
      description:
        "Search the text files in the folders the user shares from their machines, for lines that contain your words, ignoring case. Use one or two telling words, not a question. Returns at most 50 lines, each with its machine, folder, path, and line number, from every online machine that shares folders unless you name one.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .describe('Text to find, matched as written, such as "boiler".'),
        machine: z.string().max(100).optional().describe("A machine's name, to search only there."),
        folder: z
          .string()
          .max(120)
          .optional()
          .describe("A shared folder's name, to search only there."),
      }),
      execute: async (input, options: CallOptions) => {
        try {
          const found = await ctx.files.search(scope.workspaceId, {
            query: input.query,
            ...(input.machine ? { machine: input.machine } : {}),
            ...(input.folder ? { folder: input.folder } : {}),
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
          });
          return {
            hits: found.hits,
            ...(found.truncated ? { truncated: true } : {}),
            ...(found.errors.length ? { errors: found.errors } : {}),
            ...(found.hits.length === 0 && found.errors.length === 0
              ? { note: "Nothing matches. Try another word." }
              : {}),
          };
        } catch (err) {
          if (err instanceof FileError) return { error: err.message };
          throw err;
        }
      },
    }),

    read_file: tool({
      description:
        "Read a text file in a folder the user shares from a machine, from the machine, folder, and path of a search hit: up to 256 KB of it. A path that's a folder lists what's in it, and an empty path lists the shared folder.",
      inputSchema: z.object({
        machine: z.string().min(1).max(100).describe("The machine's name."),
        folder: z.string().min(1).max(120).describe("The shared folder's name."),
        path: z
          .string()
          .max(1000)
          .default("")
          .describe('The path inside the folder, such as "house/boiler.md".'),
      }),
      execute: async (input, options: CallOptions) => {
        try {
          const file = await ctx.files.read(scope.workspaceId, {
            machine: input.machine,
            folder: input.folder,
            path: input.path,
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
          });
          await audit(ctx, {
            workspaceId: scope.workspaceId,
            actorType: "agent",
            verb: "files.read",
            subjectType: "folder",
            subjectId: `${file.machine}/${file.folder}`,
            details: { conversationId: scope.conversationId, path: file.path.slice(0, 500) },
          });
          return file;
        } catch (err) {
          if (err instanceof FileError) return { error: err.message };
          throw err;
        }
      },
    }),
  };
}
