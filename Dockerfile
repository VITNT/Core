FROM node:26-bookworm-slim AS build
WORKDIR /app
ARG APP_ORIGIN
ENV APP_ORIGIN=$APP_ORIGIN
COPY package*.json ./
COPY scripts ./scripts
COPY . .
RUN npm ci
RUN npm run check && npm run build

FROM node:26-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer fonts-khmeros fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server-assets ./server-assets
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BODY_SIZE_LIMIT=55M
USER node
EXPOSE 3000
CMD ["node", "build"]
