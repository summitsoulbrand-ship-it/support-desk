/**
 * App Settings API - Global application settings
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, hasPermission } from '@/lib/auth';
import prisma from '@/lib/db';
import { z } from 'zod';

const updateSchema = z.object({
  autoMergeThreads: z.boolean().optional(),
  autoMergeWindowHours: z.number().min(1).max(168).optional(), // 1 hour to 1 week
});

// Ensure app settings exist
async function getOrCreateSettings() {
  let settings = await prisma.appSettings.findUnique({
    where: { id: 'default' },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { id: 'default' },
    });
  }

  return settings;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const settings = await getOrCreateSettings();
    return NextResponse.json(settings);
  } catch (err) {
    console.error('Error fetching app settings:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Only admins can change app settings
    if (!hasPermission(session.user.role, 'MANAGE_SETTINGS')) {
      return NextResponse.json(
        { error: 'Only administrators can change app settings' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const data = updateSchema.parse(body);

    // Ensure settings exist first
    await getOrCreateSettings();

    const settings = await prisma.appSettings.update({
      where: { id: 'default' },
      data,
    });

    return NextResponse.json(settings);
  } catch (err) {
    console.error('Error updating app settings:', err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: err.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
