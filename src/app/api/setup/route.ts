/**
 * One-time setup API - Creates the first admin user
 * Only works when no users exist in the database
 */

import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import prisma from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    // Check if any users already exist
    const existingUsers = await prisma.user.count();

    if (existingUsers > 0) {
      return NextResponse.json(
        { error: 'Setup already completed. Users exist.' },
        { status: 403 }
      );
    }

    const { email, password, name } = await request.json();

    if (!email || !password || !name) {
      return NextResponse.json(
        { error: 'Email, password, and name are required' },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    // Create admin user
    const passwordHash = await hash(password, 12);

    // Re-check the user count INSIDE a serializable transaction so two
    // concurrent first-time POSTs can't both pass the count===0 gate above
    // and each create an ADMIN (TOCTOU). The loser either sees count > 0 or
    // hits a serialization/unique-email conflict.
    const user = await prisma.$transaction(
      async (tx) => {
        const count = await tx.user.count();
        if (count > 0) return null;
        return tx.user.create({
          data: {
            email,
            name,
            passwordHash,
            role: 'ADMIN',
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );

    if (!user) {
      return NextResponse.json(
        { error: 'Setup already completed. Users exist.' },
        { status: 403 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Admin account created. Please log in.',
      userId: user.id,
    });
  } catch (error) {
    // P2002 = unique violation (same email raced in), P2034 = serialization
    // conflict - both mean another setup request won the race.
    const code = (error as { code?: string } | null)?.code;
    if (code === 'P2002' || code === 'P2034') {
      return NextResponse.json(
        { error: 'Setup already completed. Users exist.' },
        { status: 403 }
      );
    }
    console.error('Setup error:', error);
    return NextResponse.json(
      { error: 'Setup failed' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const existingUsers = await prisma.user.count();

    return NextResponse.json({
      setupRequired: existingUsers === 0,
    });
  } catch {
    return NextResponse.json({
      setupRequired: true,
    });
  }
}
