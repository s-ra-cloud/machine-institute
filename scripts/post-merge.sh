#!/bin/bash
set -e

npm install
echo "y" | npx drizzle-kit push
