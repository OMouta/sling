# syntax=docker/dockerfile:1
# Sling sandbox image: `sling-runner sandbox` plus git, gh, Node 24, the Codex
# CLI, Claude Code, Python 3, and build tools. An execution provider starts it
# for one task and destroys it afterwards.
#
# Build from the repo root:
#   docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:dev .

ARG RUST_VERSION=1.96
ARG NODE_MAJOR=24

FROM rust:${RUST_VERSION}-slim-trixie AS runner
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY apps/runner apps/runner
COPY crates crates
COPY packages/runner-protocol/proto packages/runner-protocol/proto
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p sling-runner \
    && cp target/release/sling-runner /usr/local/bin/sling-runner

FROM node:${NODE_MAJOR}-trixie-slim AS node

FROM debian:trixie-slim
ARG CODEX_VERSION=0.166.0
ARG CLAUDE_CODE_VERSION=2.1.318

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl git gnupg openssh-client procps \
        python3 python3-pip python3-venv \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

RUN useradd --create-home --uid 1000 --shell /bin/bash sling \
    && mkdir /workspace \
    && chown sling:sling /workspace

COPY --from=runner /usr/local/bin/sling-runner /usr/local/bin/sling-runner

USER sling
WORKDIR /workspace
ENTRYPOINT ["sling-runner", "sandbox"]
