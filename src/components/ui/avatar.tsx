/**
 * Avatar component - supports both images and initials fallback
 */

'use client';

import { cn, getInitials } from '@/lib/utils';
import { useState } from 'react';

interface AvatarProps {
  name: string;
  email?: string;
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

export function Avatar({ name, imageUrl, size = 'md', className }: AvatarProps) {
  const [imageError, setImageError] = useState(false);

  const sizes = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
    xl: 'w-16 h-16 text-xl',
  };

  // Generate a consistent color based on name
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-yellow-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-indigo-500',
    'bg-teal-500',
    'bg-orange-500',
  ];

  const colorIndex =
    name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) %
    colors.length;

  // Show image if available and hasn't errored
  if (imageUrl && !imageError) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className={cn(
          'rounded-full object-cover flex-shrink-0',
          sizes[size],
          className
        )}
        onError={() => setImageError(true)}
      />
    );
  }

  // Fallback to initials
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-full text-white font-medium flex-shrink-0',
        sizes[size],
        colors[colorIndex],
        className
      )}
    >
      {getInitials(name)}
    </div>
  );
}
