FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git ca-certificates \
 && curl -fsSL https://nixpacks.com/install.sh | bash \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=3000
CMD ["node", "server.js"]
