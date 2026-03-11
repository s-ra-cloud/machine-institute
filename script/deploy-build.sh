#!/bin/bash
set -e
npm install
npm run build
npm run db:push
npx tsx server/seed-production.ts
