# Connectors

One package per connector, each exporting a `ConnectorDefinition` from `@sling/connector-sdk` as `connector`. The server registers them at startup.

| Package | Connector | Setup |
|---|---|---|
| `@sling/integration-discord` | Discord bot over the gateway, with approval buttons | [docs/connectors/discord.md](../docs/connectors/discord.md) |
| `@sling/integration-email` | IMAP and SMTP | [docs/connectors/email.md](../docs/connectors/email.md) |

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
