# Optional: run with Docker (the default deployment is the systemd setup in deploy/install.sh)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app/server
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/server/node_modules /app/server/node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/public ./public
COPY --from=build /app/server/package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
