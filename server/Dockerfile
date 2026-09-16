# Render / production Dockerfile for Node.js backend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
# Install prod deps only
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts || npm install --omit=dev
EXPOSE 10000
ENV PORT=10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1
CMD ["node", "dist/index.js"]
