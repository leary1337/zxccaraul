# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit

COPY --chown=pwuser:pwuser server.mjs ./server.mjs
COPY --chown=pwuser:pwuser public ./public

EXPOSE 5173

USER pwuser

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5173/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "server.mjs"]
