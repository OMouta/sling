# Development

## Prerequisites

- Node.js 24 and pnpm 12 (`packageManager` in `package.json` pins the version)
- Rust stable
- Docker, for Postgres and the end-to-end tests
- Optional: Codex, for real runs. `fake-codex` covers everything else.

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
cargo build -p sling-runner -p sling-harness-codex
export SLING_RUNNER_HOME=/tmp/sling-dev-runner
./target/debug/sling-runner repo add ~/code/some-repo
./target/debug/sling-runner config set codex-bin "$PWD/target/debug/fake-codex"
./target/debug/sling-runner pair http://localhost:5173 <code>
./target/debug/sling-runner run
```

`fake-codex` behaves like `codex exec --json`. Put `[fake:fail]`, `[fake:hang]`, `[fake:crash]`, or `[fake:noop]` in a task objective to pick a scenario.

## Layout

| Path | What |
|---|---|
| `apps/server` | Control plane: Fastify, Better Auth, task service, Runner gateway, master agent |
| `apps/web` | React web app |
| `apps/runner` | `sling-runner` (Rust) |
| `packages/core` | Shared TS: permission modes, task states, API types |
| `packages/db` | Drizzle schema and migrations |
| `packages/runner-protocol` | `.proto` source of truth and generated TS |
| `crates/runner-protocol` | Generated Rust (prost) |
| `crates/harness-codex` | Codex adapter and `fake-codex` |
| `deploy` | Dockerfile and compose files |
| `plan` | Spec, decisions log, Stage 1 plan, spike notes |

The server runs TypeScript directly with Node's type stripping, so there's no build step. That means no TS enums or parameter properties (`erasableSyntaxOnly` catches them).

## Checks

```sh
pnpm lint            # Biome
pnpm typecheck
pnpm test            # unit tests, all TS packages
pnpm test:e2e        # builds the Runner, then runs Postgres + server + Runner + fake-codex
cargo clippy --all-targets -- -D warnings
cargo test --all
```

## Changing things

- **Database:** edit `packages/db/src/schema/*.ts`, then `pnpm --filter @sling/db generate`. Migrations apply on server start.
- **Runner protocol:** edit the `.proto`, then `pnpm gen`, and `pnpm --filter @sling/runner-protocol fixtures` if the fixture messages changed. The Rust side regenerates on build. CI runs `buf breaking` on pull requests.
- **Better Auth plugins:** update `apps/server/src/auth/schema-gen.ts` to match, then `pnpm --filter @sling/server auth:schema`.
