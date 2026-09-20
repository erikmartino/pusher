FROM docker.io/library/node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/erikmartino/pusher"
LABEL org.opencontainers.image.description="Tactile Push Button Progressive Web App with Native Web Push"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy server, static application files, and optional persistent configuration
COPY server.mjs index.html sw.js manifest.json browserconfig.xml .vapid.json* .data.json* .subscriptions.json* ./
COPY icons ./icons

ARG COMMIT_SHA=""
RUN if [ -n "$COMMIT_SHA" ]; then \
      sed -i -E "s|https://github.com/erikmartino/pusher(/commit/[^\"]*)?|https://github.com/erikmartino/pusher/commit/${COMMIT_SHA}|g" index.html; \
    fi

ENV PORT=80
ENV DATA_DIR=/data
ENV NODE_ENV=production

VOLUME ["/data"]

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

CMD ["node", "server.mjs"]
