# Build tools live only in the build stage; the runtime image has Node, four packages and the built files.
FROM docker.io/library/node:22-alpine AS build
LABEL app=pg-ch-bench
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM docker.io/library/node:22-alpine AS deps
LABEL app=pg-ch-bench
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM docker.io/library/node:22-alpine
LABEL app=pg-ch-bench
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
