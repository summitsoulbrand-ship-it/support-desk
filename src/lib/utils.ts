/**
 * Utility functions
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with Tailwind CSS support
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format date for display
 */
export function formatDate(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  } else {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

/**
 * Format date with full details
 */
export function formatDateFull(date: Date | string): string {
  const d = new Date(date);
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format date as full date with relative time in brackets (e.g., "Mon, Mar 30, 9:31 PM (Yesterday)")
 */
export function formatDateRelative(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Full date format: "Mon, Mar 30, 9:31 PM"
  const fullDate = d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // Relative part in brackets
  let relative = '';
  if (diffMins < 1) {
    relative = 'Just now';
  } else if (diffMins < 60) {
    relative = `${diffMins} min ago`;
  } else if (diffHours < 24) {
    relative = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else if (diffDays === 1) {
    relative = 'Yesterday';
  } else if (diffDays < 7) {
    relative = `${diffDays} days ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    relative = `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  }

  // Return with relative in brackets if applicable
  if (relative) {
    return `${fullDate} (${relative})`;
  }
  return fullDate;
}

/**
 * Format currency
 */
export function formatCurrency(
  amount: string | number,
  currency: string = 'USD'
): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(num);
}

/**
 * Truncate text
 */
export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.substring(0, length) + '...';
}

/**
 * Get initials from name
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .substring(0, 2);
}

/**
 * Status badge colors
 */
export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    OPEN: 'bg-green-100 text-green-800',
    PENDING: 'bg-yellow-100 text-yellow-800',
    CLOSED: 'bg-gray-100 text-gray-800',
    PAID: 'bg-green-100 text-green-800',
    UNFULFILLED: 'bg-yellow-100 text-yellow-800',
    FULFILLED: 'bg-blue-100 text-blue-800',
    PARTIALLY_FULFILLED: 'bg-orange-100 text-orange-800',
    CANCELLED: 'bg-red-100 text-red-800',
    REFUNDED: 'bg-purple-100 text-purple-800',
  };

  return colors[status] || 'bg-gray-100 text-gray-800';
}
