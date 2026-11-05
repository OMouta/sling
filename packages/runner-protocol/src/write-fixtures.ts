import { writeFileSync } from "node:fs";
import { fixtures } from "./fixtures.ts";
import { encodeEnvelope } from "./index.ts";

const dir = new URL("../fixtures/", import.meta.url);
for (const [name, envelope] of Object.entries(fixtures)) {
  writeFileSync(new URL(`${name}.bin`, dir), encodeEnvelope(envelope));
}
