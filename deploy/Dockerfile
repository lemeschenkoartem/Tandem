# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
WORKDIR /opt/tandem
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY --chown=node:node server ./server
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIRECTORY=/data
EXPOSE 8787
CMD ["node", "server/index.cjs"]
