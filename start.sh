#!/bin/sh
set -e

echo "Generating Prisma client..."
node node_modules/prisma/build/index.js generate

echo "Checking database state..."
# Check if tables already exist (from backup restore)
TABLE_EXISTS=$(node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.\$queryRaw\`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'\`
  .then(r => { console.log(r[0].count > 0 ? 'yes' : 'no'); process.exit(0); })
  .catch(() => { console.log('no'); process.exit(0); });
" 2>/dev/null || echo "no")

if [ "$TABLE_EXISTS" = "yes" ]; then
  echo "Database tables exist, skipping migrations..."
else
  echo "Running database migrations..."
  node node_modules/prisma/build/index.js migrate deploy

  echo "Creating default admin if needed..."
  node scripts/create-admin.js
fi

echo "Starting server..."
exec node server.js
