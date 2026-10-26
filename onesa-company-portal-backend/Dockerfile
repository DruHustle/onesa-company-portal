FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci
FROM dependencies AS build
COPY . .
RUN npm run build
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
RUN apk upgrade --no-cache zlib musl musl-utils
RUN apk add --no-cache 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3'
ENV NODE_ENV=production PORT=8300 STORAGE_DIR=/app/storage
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p storage && chown node:node storage
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
# Node starts the application directly; package managers are build-only tooling.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Protect every Node entry point, including worker and health commands.
ENV NODE_OPTIONS="--import=/app/dist/src/security/tls-trust.js"
USER node
EXPOSE 8300
# Production dependency monitoring retains readiness; Oracle staging overrides this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8300') + '/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/src/server.js"]
