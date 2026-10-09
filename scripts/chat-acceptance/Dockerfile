# Acceptance-only image: separate from the VPS/worker production images.
FROM node:22-alpine AS build
WORKDIR /fixture
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/chat/package.json services/chat/package-lock.json ./services/chat/
RUN cd services/chat && npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts/chat-acceptance ./scripts/chat-acceptance
RUN node scripts/chat-acceptance/build.mjs

FROM node:22-alpine
WORKDIR /fixture
COPY --from=build /fixture/node_modules ./node_modules
COPY --from=build /fixture/scripts/chat-acceptance/dist/web.mjs ./web.mjs
USER node
CMD ["node", "web.mjs"]
