#!/bin/sh
set -e

echo "Generating Prisma client..."
node node_modules/prisma/build/index.js generate

echo "Checking database state..."
# Check if tables already exist (from backup restore)
DB_STATE=$(node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  try {
    const tables = await prisma.\$queryRaw\`SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'\`;
    const hasTables = tables[0].c > 0;
    const migrations = await prisma.\$queryRaw\`SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations'\`;
    const hasMigrations = migrations[0].c > 0;
    console.log(hasTables ? (hasMigrations ? 'ready' : 'needs_baseline') : 'fresh');
  } catch (e) {
    console.log('fresh');
  }
  process.exit(0);
})();
" 2>/dev/null || echo "fresh")

echo "Database state: $DB_STATE"

if [ "$DB_STATE" = "needs_baseline" ]; then
  echo "Database exists but needs migration baseline (restored from backup)..."
  # Mark all existing migrations as applied
  node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const path = require('path');

(async () => {
  // Create _prisma_migrations table
  await prisma.\$executeRawUnsafe(\`
    CREATE TABLE IF NOT EXISTS _prisma_migrations (
      id VARCHAR(36) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_steps_count INT NOT NULL DEFAULT 0
    )
  \`);

  // Get all migration directories
  const migrationsDir = path.join(__dirname, 'prisma/migrations');
  const migrations = fs.readdirSync(migrationsDir)
    .filter(f => fs.statSync(path.join(migrationsDir, f)).isDirectory() && f !== '.');

  for (const migration of migrations) {
    const id = require('crypto').randomUUID();
    await prisma.\$executeRawUnsafe(\`
      INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
      VALUES ('\${id}', 'baseline', NOW(), '\${migration}', 1)
      ON CONFLICT DO NOTHING
    \`);
    console.log('Marked as applied:', migration);
  }

  console.log('Baseline complete');
  process.exit(0);
})();
" || echo "Baseline failed, continuing..."
fi

# Run migrations (will apply any new migrations not yet in the table)
echo "Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy || echo "Migrations completed with warnings"

if [ "$DB_STATE" = "fresh" ]; then
  echo "Creating default admin for new database..."
  node scripts/create-admin.js
fi

echo "Starting server..."
exec node server.js
