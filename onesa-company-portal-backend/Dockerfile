FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci
FROM dependencies AS build
COPY . .
RUN npm run build
FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=8300 STORAGE_DIR=/app/storage
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p storage && chown node:node storage
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 8300
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8300/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/src/server.js"]
