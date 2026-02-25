/**
 * NextAuth configuration with credentials provider and RBAC
 */

import { NextAuthOptions, getServerSession } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { UserRole } from '@prisma/client';
import prisma from '@/lib/db';
import { verifyPassword } from '@/lib/encryption';
import { checkRateLimit, resetRateLimit } from '@/lib/rate-limit';

// Extend NextAuth types
declare module 'next-auth' {
  interface User {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  }

  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Rate limit by email to prevent brute force attacks
        // 5 attempts per 15 minutes per email address
        const rateLimit = checkRateLimit(credentials.email.toLowerCase(), 5, 15 * 60 * 1000);
        if (!rateLimit.success) {
          throw new Error(`Too many login attempts. Try again in ${Math.ceil(rateLimit.resetIn / 60)} minutes.`);
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user || !user.active) {
          return null;
        }

        const isValid = await verifyPassword(
          credentials.password,
          user.passwordHash
        );

        if (!isValid) {
          return null;
        }

        // Reset rate limit on successful login
        resetRateLimit(credentials.email.toLowerCase());

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        id: token.id,
        email: token.email,
        name: token.name,
        role: token.role,
      };
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60, // 24 hours
  },
  secret: process.env.NEXTAUTH_SECRET,
};

/**
 * Get the current session (server-side)
 */
export async function getSession() {
  return getServerSession(authOptions);
}

/**
 * Check if user has required role
 */
export function hasRole(
  userRole: UserRole,
  requiredRoles: UserRole[]
): boolean {
  return requiredRoles.includes(userRole);
}

/**
 * Check if user is admin
 */
export function isAdmin(role: UserRole): boolean {
  return role === 'ADMIN';
}

/**
 * Permission definitions
 */
export const PERMISSIONS = {
  // Thread permissions
  VIEW_THREADS: ['ADMIN', 'AGENT'] as UserRole[],
  REPLY_THREADS: ['ADMIN', 'AGENT'] as UserRole[],
  ASSIGN_THREADS: ['ADMIN', 'AGENT'] as UserRole[],
  CHANGE_STATUS: ['ADMIN', 'AGENT'] as UserRole[],

  // User management
  MANAGE_USERS: ['ADMIN'] as UserRole[],
  VIEW_USERS: ['ADMIN', 'AGENT'] as UserRole[], // Agents need to see teammates for assignment

  // Integration settings
  MANAGE_INTEGRATIONS: ['ADMIN'] as UserRole[],
  VIEW_INTEGRATIONS: ['ADMIN'] as UserRole[],

  // App settings
  MANAGE_SETTINGS: ['ADMIN'] as UserRole[],

  // Export data
  EXPORT_DATA: ['ADMIN'] as UserRole[],
};

/**
 * Check if user has specific permission
 */
export function hasPermission(
  userRole: UserRole,
  permission: keyof typeof PERMISSIONS
): boolean {
  return PERMISSIONS[permission].includes(userRole);
}
