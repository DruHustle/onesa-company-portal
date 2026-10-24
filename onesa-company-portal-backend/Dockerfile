FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci
FROM dependencies AS build
COPY . .
RUN npm run build
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8300') + '/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/src/server.js"]
