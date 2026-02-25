#!/bin/sh
set -e

echo "Generating Prisma client..."
node node_modules/prisma/build/index.js generate

echo "Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy

echo "Creating default admin if needed..."
node -e "
const { PrismaClient } = require('@prisma/client');

async function createAdmin() {
  const prisma = new PrismaClient();
  try {
    const count = await prisma.user.count();
    if (count === 0) {
      await prisma.user.create({
        data: {
          email: 'admin@support.local',
          name: 'Admin',
          passwordHash: '\$2b\$12\$G/Q2uLTLjUwMZtFiL5QzxuKcPrh5RpxNOjHBT4KS9jLgh77IRtxF2',
          role: 'ADMIN',
        }
      });
      console.log('Created default admin: admin@support.local / admin123');
    } else {
      console.log('Users exist, skipping admin creation');
    }
  } catch (e) {
    console.log('Admin creation skipped:', e.message);
  } finally {
    await prisma.\$disconnect();
  }
}
createAdmin();
"

echo "Starting server..."
exec node server.js
