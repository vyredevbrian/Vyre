FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Nixpacks builds repos that have no Dockerfile. Do not fail the image if the download is blocked; vyre says so at deploy time.
RUN (curl -fsSL https://nixpacks.com/install.sh -o /tmp/nixpacks-install.sh && bash /tmp/nixpacks-install.sh && nixpacks --version) \
 || echo "WARNING: nixpacks not installed"; rm -f /tmp/nixpacks-install.sh
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY *.js ./
COPY public ./public
ENV PORT=3000
CMD ["node", "--no-warnings", "server.js"]
