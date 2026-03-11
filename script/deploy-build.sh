#!/bin/bash
set -e
npm install
npm run build
npx drizzle-kit push --force
npx tsx server/seed-production.ts
