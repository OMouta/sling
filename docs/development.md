# Development

## Prerequisites

- Node.js 26 and pnpm 12 (`packageManager` in `package.json` pins the version)
- Rust stable
- Docker, for Postgres and the end-to-end tests
- Optional: Codex or Claude Code, for real runs. `fake-codex` and `fake-claude` cover everything else.

## First run

```sh
pnpm install
docker compose -f deploy/docker-compose.dev.yml up -d   # Postgres on 127.0.0.1:5433
cp .env.example .env                                     # set SLING_SECRET_KEY
pnpm extensions:build                                    # the extension catalog that ships with Sling
pnpm dev                                                 # server on :8080, web on :5173
```

Open http://localhost:5173. Vite forwards `/api` and `/runner` to the server, which is why `SLING_PUBLIC_URL` points at the Vite port in development.

A Runner against the dev server, with a fake Codex and its own home directory:

```sh
cargo build -p sling-runner -p sling-harness-codex -p sling-harness-claude-code
export SLING_RUNNER_HOME=/tmp/sling-dev-runner
./target/debug/sling-runner repo add ~/code/some-repo
./target/debug/sling-runner config set codex-bin "$PWD/target/debug/fake-codex"
./target/debug/sling-runner config set claude-bin "$PWD/target/debug/fake-claude"
./target/debug/sling-runner pair http://localhost:5173 <code>
./target/debug/sling-runner run
```

`fake-codex` behaves like `codex exec --json`, and `fake-claude` like `claude -p --output-format stream-json`. With Codex as the chat's assistant, a message with `[fake:call] {"name": "run_command", "arguments": {"command": "ls"}}` makes fake-codex call that Sling tool, so commands, approvals, and tasks can be tried in the chat without a Codex login. Put `[fake:fail]`, `[fake:hang]`, `[fake:crash]`, `[fake:noop]`, or `[fake:env]` in a task objective to pick a scenario. `env` reports which `SLING_*` variables, tokens, and API keys the agent can see.

The routing and sandbox end-to-end tests (`apps/server/test/stage3.e2e.test.ts`) register two test execution providers from `test/fixtures/providers.ts`. `test-fake` boots a TypeScript Runner in the test process that pairs with the sandbox's code. `test-process` runs the real `target/debug/sling-runner sandbox` as a child process with the sandbox's environment, cloning from a local bare repo and running `fake-codex`; its test skips itself when the Runner build has no `sandbox` command. The server's `testing` config passes `SLING_CODEX_BIN` to sandboxes and allows `file://` clone URLs.

## Layout

| Path | What |
|---|---|
| `apps/server` | Control plane: Fastify, Better Auth, task service, Runner gateway, master agent, workflow engine |
| `apps/web` | React web app |
| `apps/runner` | `sling-runner` (Rust) |
| `packages/core` | Shared TS: permission modes, task states, API types |
| `packages/db` | Drizzle schema and migrations |
| `packages/workflow` | Workflow format, node spec contract, validation, traversal, and JSONata evaluation. No server code, so the web app uses it too |
| `packages/connector-sdk` | The extension SDK: connectors, nodes, event sources, sandbox providers, `defineExtension`, and the manifest, catalog, and signature formats. `api-report.d.ts` records its public API |
| `packages/extension-package` | The `.slx` format: deterministic tar, content digest, Ed25519 signatures |
| `packages/extension-runtime` | The code that runs inside each extension's restricted process. Plain `.mjs`, `node:` imports only |
| `packages/extension-cli` | `sling-ext`: init, build, check, keygen, pack, sign, verify, catalog |
| `extensions` | The example extensions that make up the catalog included with Sling. `pnpm extensions:build` packs them into `extensions/dist` |
| `integrations` | Connectors, one package each |
| `workflows` | Bundled workflow templates, one directory each |
| `packages/runner-protocol` | `.proto` source of truth and generated TS |
| `crates/runner-protocol` | Generated Rust (prost) |
| `crates/harness-codex` | Codex adapter and `fake-codex` |
| `crates/harness-claude-code` | Claude Code adapter and `fake-claude` |
| `deploy` | Dockerfile and compose files. `deploy/sandbox` builds the sandbox image |
| `plan` | Spec, decisions log, each stage's plan, spike notes |

The server runs TypeScript directly with Node's type stripping, so there's no build step. That means no TS enums or parameter properties (`erasableSyntaxOnly` catches them).

## Checks

```sh
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests, all TS packages
pnpm test:e2e        # builds the Runner, then runs Postgres + server + Runner + fake-codex, and the workflow engine tests
cargo clippy --all-targets -- -D warnings
cargo test --all
```

Extension end-to-end tests run extension code in the test process by default. To run them on real restricted processes, as production does:

```sh
SLING_TEST_EXTENSION_RUNTIME=process pnpm --filter @sling/server test:e2e
```

`apps/server/test/stage4.e2e.test.ts` always uses real processes. With `SLING_LIVE_NTFY=1` its ntfy part runs against ntfy.sh with the included package as it ships, instead of a local fake. It needs no account.

A few journeys run in a real browser against a running Sling that serves the built app: signing in, sending a message whose response is lost, drafts, archiving, dialogs and tabs by keyboard, pairing, and reconnecting. They set Sling up on a fresh database, or sign in on one they set up before:

```sh
pnpm --filter @sling/web build
# Sling with SLING_WEB_DIST=apps/web/dist on :8080, on its own database
pnpm --filter @sling/web exec playwright install chromium
SLING_BROWSER_URL=http://localhost:8080 pnpm --filter @sling/web test:browser
```

`PLAYWRIGHT_CHROMIUM` points the suite at a Chromium already on the machine instead.

Two more Rust checks need something outside the repo:

```sh
# Real Claude Code runs with each mode's flags. Uses your Claude Code login.
SLING_LIVE_CLAUDE=1 cargo test -p sling-harness-claude-code --test live -- --ignored
# The sandbox boot tests inside the sandbox image.
docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:dev .
SLING_SANDBOX_IMAGE=sling-sandbox:dev cargo test -p sling-runner --test sandbox
```

## Web bundle size

```sh
pnpm --filter @sling/web build
node scripts/web-bundle-size.mjs --check
```

The script lists what the first page load fetches (the entry script, the chunks it
preloads, and the stylesheet) and each chunk loaded on demand, raw and compressed with
gzip level 9 and brotli quality 11. With `--check` it fails when the compressed first
load exceeds `apps/web/bundle-budget.json`; CI runs it after the web build. If growth
is intended, raise the budget in the same change and say why. Sling's server sends
these files uncompressed, so behind no compressing proxy the raw column is what
browsers download.

Measured on 2026-11-09, before route pages were loaded on demand (`4a2de99`) and after:

| First load | Raw | gzip | brotli |
|---|---:|---:|---:|
| Before (entry script 778.5 KiB raw) | 1045.3 KiB | 307.6 KiB (315,012 B) | 259.7 KiB (265,914 B) |
| After (entry script 508.9 KiB raw) | 913.9 KiB | 276.7 KiB (283,358 B) | 239.5 KiB (245,251 B) |
| Budget | | 292,000 B | 253,000 B |

The first load is 12 files after the change: the entry script, 10 preloaded chunks, and
the stylesheet (82.7 KiB raw, 15.7 KiB gzip). Two of the preloaded chunks are shared
code the split pulled out of the entry: `lib` (118.4 KiB raw, 35.7 KiB gzip) and
`Wizard` (21.6 KiB raw, 6.9 KiB gzip). They're the next candidates for loading on
demand.

Routes loaded on demand:

| Page | Raw | gzip | brotli |
|---|---:|---:|---:|
| Machines | 23.6 KiB | 7.6 KiB | 6.9 KiB |
| Sandboxes | 6.2 KiB | 2.3 KiB | 2.1 KiB |
| Checks | 29.6 KiB | 9.6 KiB | 8.7 KiB |
| Settings | 36.2 KiB | 11.4 KiB | 10.2 KiB |
| Workflow editor | 40.4 KiB | 12.3 KiB | 11.0 KiB |
| Workflow run | 6.9 KiB | 2.6 KiB | 2.4 KiB |
| Personalities (list and editor) | 29.7 KiB | 8.9 KiB | 8.0 KiB |
| Memory | 7.2 KiB | 2.8 KiB | 2.5 KiB |
| Connectors | 9.7 KiB | 3.7 KiB | 3.4 KiB |
| Extensions | 32.3 KiB | 9.0 KiB | 8.1 KiB |

The workflow node catalog (372.2 KiB raw, 115.0 KiB gzip) also loads on demand, with
the workflow pages.

## Changing things

- **Database:** edit `packages/db/src/schema/*.ts`, then `pnpm --filter @sling/db generate`. Migrations apply on server start.
- **Runner protocol:** edit the `.proto`, then `pnpm gen`, and `pnpm --filter @sling/runner-protocol fixtures` if the fixture messages changed. The Rust side regenerates on build. CI runs `buf breaking` on pull requests.
- **Workflow nodes:** core nodes live in `apps/server/src/workflows/nodes` and are registered in `nodes/index.ts`. Give every config field a `.describe()`; the editor shows it as help text. Connector nodes come with their connector and are registered with `registerConnector`.
- **Workflow templates:** add a directory under `workflows/` with `template.json` and `workflow.json` (see `workflows/README.md`). A template whose node types aren't registered isn't offered. Templates marked `builtIn` are installed and enabled in every workspace on start.
- **The extension SDK:** a change to anything `packages/connector-sdk/src/index.ts` exports changes the API report. Run `pnpm --filter @sling/connector-sdk api-report`, commit `api-report.d.ts` with the change, and bump the SDK version to match.
- **Example extensions:** edit them under `extensions/`, then `pnpm extensions:build`. The server reads the included catalog when it starts, so restart it to see the change. It offers **Update** when the version went up.
- **Better Auth plugins:** update `apps/server/src/auth/schema-gen.ts` to match, then `pnpm --filter @sling/server auth:schema`.
