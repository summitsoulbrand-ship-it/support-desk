#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Seeding database (if needed)..."
npx prisma db seed || echo "Seed skipped or already done"

echo "Starting server..."
exec node server.js
