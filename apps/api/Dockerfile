FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl && corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/website/package.json apps/website/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm --filter @psk/api db:generate && pnpm --filter @psk/api build
RUN pnpm install --prod --filter @psk/api... --no-frozen-lockfile

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl && corepack enable
COPY --from=build /app ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=45s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "pnpm --filter @psk/api db:migrate && pnpm --filter @psk/api start"]
