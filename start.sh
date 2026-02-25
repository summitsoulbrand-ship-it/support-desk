#!/bin/sh
set -e

echo "Generating Prisma client..."
node node_modules/prisma/build/index.js generate

echo "Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy

echo "Creating default admin if needed..."
node scripts/create-admin.js

echo "Starting server..."
exec node server.js
