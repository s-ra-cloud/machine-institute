#!/bin/bash
set -e
npm install
npm run build
echo "y" | npx drizzle-kit push
