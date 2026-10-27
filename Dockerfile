FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vitest.config.mts ./
COPY src ./src
COPY web ./web
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
USER node
EXPOSE 4100
# Applies pending migrations, then starts the API, dashboard and webhook dispatcher.
CMD ["npm", "start"]
