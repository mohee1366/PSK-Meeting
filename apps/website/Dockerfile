FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/website/package.json apps/website/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --no-frozen-lockfile
COPY . .
ARG VITE_APP_URL=http://localhost:8080
ENV VITE_APP_URL=$VITE_APP_URL
RUN pnpm --filter @psk/website build
FROM nginx:1.27-alpine
COPY apps/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/website/dist /usr/share/nginx/html
EXPOSE 80
