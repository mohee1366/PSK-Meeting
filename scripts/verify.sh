#!/usr/bin/env sh
set -eu
node --version
pnpm --version
node --test tests/*.test.mjs
pnpm db:generate
pnpm typecheck
pnpm build
