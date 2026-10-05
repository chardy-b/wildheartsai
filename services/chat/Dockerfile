# Build context is the Wild Hearts repository root, not services/chat.
FROM node:22-alpine AS build
WORKDIR /app/services/chat
COPY services/chat/package.json services/chat/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/chat/build.mjs services/chat/tsconfig.json ./
COPY services/chat/src ./src
COPY src /app/src
RUN npm run build

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY services/chat/package.json services/chat/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
ENV NODE_ENV=production
USER node

FROM dependencies AS service
COPY --from=build /app/services/chat/dist/index.js ./dist/index.js
EXPOSE 8080
CMD ["node", "dist/index.js"]

# Worker receives no service bundle, database connection, signing key, or record key.
FROM dependencies AS worker
COPY --from=build /app/services/chat/dist/worker-entry.js ./dist/worker-entry.js
CMD ["node", "dist/worker-entry.js"]
