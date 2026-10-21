FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN useradd --create-home --uid 10001 plexbridge && mkdir /config && chown -R plexbridge:plexbridge /app /config
USER plexbridge
EXPOSE 32400
CMD ["node", "dist/src/server.js"]

