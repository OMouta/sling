# Connectors

One package per connector, each exporting a `ConnectorDefinition` from `@sling/connector-sdk` as `connector`. The server registers them at startup.

| Package | Connector | Setup |
|---|---|---|
| `@sling/integration-discord` | Discord bot over the gateway, with approval buttons | [docs/connectors/discord.md](../docs/connectors/discord.md) |
| `@sling/integration-email` | IMAP and SMTP | [docs/connectors/email.md](../docs/connectors/email.md) |
| `@sling/integration-calendar` | CalDAV calendars, and iCal links read-only | [docs/connectors/calendar.md](../docs/connectors/calendar.md) |
| `@sling/integration-docker` | Sandboxes as containers on a Docker host | [docs/connectors/docker.md](../docs/connectors/docker.md) |
| `@sling/integration-railway` | Sandboxes in Railway Sandboxes | [docs/connectors/railway.md](../docs/connectors/railway.md) |

Docker and Railway are execution providers. They have no workflow nodes. The control plane calls their `executionProvider` to create, list, and destroy sandboxes.

## Tests

`pnpm test` runs the unit tests. Discord's run against a fake gateway and REST client, so they need no network.

The email connector also has integration tests against GreenMail, a real IMAP and SMTP server, started in Docker by testcontainers:

```sh
pnpm --filter @sling/integration-email test:integration
```

With OrbStack, point testcontainers at its socket first:

```sh
export DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
export TESTCONTAINERS_RYUK_DISABLED=true
```

The calendar connector's integration tests run against Radicale, a real CalDAV server, in Docker, and a local HTTP server for iCal links. They also print the read and parse times:

```sh
pnpm --filter @sling/integration-calendar test:integration
```

The Docker provider's integration tests start containers on the local daemon. They pull `alpine:3` and `busybox:1.36.1-musl`, and remove everything they create:

```sh
export DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
pnpm --filter @sling/integration-docker test:integration
```

The Railway provider's live tests create real sandboxes, which bill for the minute or two they run. They skip unless both variables are set:

```sh
RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... pnpm --filter @sling/integration-railway test:integration
```

Add `RAILWAY_TOKEN_TYPE=project` for a project token.
