FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
# Match the SDK version. Cantelop supplies the runtime user and durable workspace.
RUN npm install --global @openai/codex@0.146.1
ENV CODEX_BINARY=/usr/local/bin/codex
