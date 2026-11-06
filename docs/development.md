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

`fake-codex` behaves like `codex exec --json`, and `fake-claude` like `claude -p --output-format stream-json`. Put `[fake:fail]`, `[fake:hang]`, `[fake:crash]`, `[fake:noop]`, or `[fake:env]` in a task objective to pick a scenario. `env` reports which `SLING_*` variables, tokens, and API keys the agent can see.

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
| `packages/connector-sdk` | What a connector provides: credentials, a connection test, nodes, and an event source |
| `integrations` | Connectors, one package each |
| `workflows` | Bundled workflow templates, one directory each |
| `packages/runner-protocol` | `.proto` source of truth and generated TS |
| `crates/runner-protocol` | Generated Rust (prost) |
| `crates/harness-codex` | Codex adapter and `fake-codex` |
| `crates/harness-claude-code` | Claude Code adapter and `fake-claude` |
| `deploy` | Dockerfile and compose files. `deploy/sandbox` builds the sandbox image |
| `plan` | Spec, decisions log, Stage 1 plan, spike notes |

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

Two more Rust checks need something outside the repo:

```sh
# Real Claude Code runs with each mode's flags. Uses your Claude Code login.
SLING_LIVE_CLAUDE=1 cargo test -p sling-harness-claude-code --test live -- --ignored
# The sandbox boot tests inside the sandbox image.
docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:dev .
SLING_SANDBOX_IMAGE=sling-sandbox:dev cargo test -p sling-runner --test sandbox
```

## Changing things

- **Database:** edit `packages/db/src/schema/*.ts`, then `pnpm --filter @sling/db generate`. Migrations apply on server start.
- **Runner protocol:** edit the `.proto`, then `pnpm gen`, and `pnpm --filter @sling/runner-protocol fixtures` if the fixture messages changed. The Rust side regenerates on build. CI runs `buf breaking` on pull requests.
- **Workflow nodes:** core nodes live in `apps/server/src/workflows/nodes` and are registered in `nodes/index.ts`. Give every config field a `.describe()`; the editor shows it as help text. Connector nodes come with their connector and are registered with `registerConnector`.
- **Workflow templates:** add a directory under `workflows/` with `template.json` and `workflow.json` (see `workflows/README.md`). A template whose node types aren't registered isn't offered. Templates marked `builtIn` are installed and enabled in every workspace on start.
- **Better Auth plugins:** update `apps/server/src/auth/schema-gen.ts` to match, then `pnpm --filter @sling/server auth:schema`.
