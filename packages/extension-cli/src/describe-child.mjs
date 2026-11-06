// Runs inside the restricted process `sling-ext check` starts: imports an
// extension's bundle, calls describe(), and sends the result back over IPC.
import { pathToFileURL } from "node:url";

function send(message) {
  return new Promise((resolve) => process.send(message, () => resolve()));
}

function describeError(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

try {
  const mod = await import(pathToFileURL(process.argv[2]).href);
  const extension = mod.default;
  if (!extension || typeof extension.describe !== "function") {
    await send({
      ok: false,
      error:
        "The bundle's default export isn't an extension. Export defineExtension({ connectors }).",
    });
  } else {
    const description = extension.describe();
    try {
      await send({ ok: true, description });
    } catch (error) {
      await send({
        ok: false,
        error: `describe() returned something Sling can't read: ${describeError(error)}`,
      });
    }
  }
} catch (error) {
  await send({ ok: false, error: describeError(error) });
}
// Timers the bundle started at import time would keep the process alive.
process.exit(0);
