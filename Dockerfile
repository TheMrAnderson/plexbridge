FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
RUN useradd --create-home --uid 10001 plexbridge && mkdir /config && chown -R plexbridge:plexbridge /app /config
USER plexbridge
EXPOSE 32400
CMD ["node", "dist/src/server.js"]

