/**
 * File upload security utilities
 * Validates file size, type, and sanitizes filenames
 */

// Maximum file size: 10MB
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Maximum total upload size per request: 25MB
export const MAX_TOTAL_UPLOAD_SIZE = 25 * 1024 * 1024;

// Allowed MIME types for attachments
export const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  // Text
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  // Archives
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  // Other
  'application/json',
  'application/xml',
  'application/octet-stream', // Generic binary (fallback type)
  // Video (in case someone sends screen recordings)
  'video/mp4',
  'video/quicktime',
  'video/webm',
  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
]);

// Dangerous file extensions to block
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.jar',
  '.msi', '.dll', '.com', '.scr', '.pif', '.hta', '.cpl',
  '.reg', '.inf', '.lnk', '.url', '.php', '.asp', '.aspx',
  '.cgi', '.pl', '.py', '.rb', '.jsp', '.jspx',
]);

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a single file upload
 */
export function validateFile(
  filename: string,
  mimeType: string,
  size: number
): FileValidationResult {
  // Check file size
  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File "${filename}" exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    };
  }

  // Check for blocked extensions
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `File type "${ext}" is not allowed for security reasons`,
    };
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.has(mimeType) && !mimeType.startsWith('image/')) {
    return {
      valid: false,
      error: `File type "${mimeType}" is not allowed`,
    };
  }

  // Check for double extensions (e.g., "file.jpg.exe")
  const parts = filename.split('.');
  if (parts.length > 2) {
    const suspiciousExt = '.' + parts[parts.length - 1].toLowerCase();
    if (BLOCKED_EXTENSIONS.has(suspiciousExt)) {
      return {
        valid: false,
        error: `Suspicious file extension pattern detected`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate multiple file uploads
 */
export function validateFiles(
  files: Array<{ filename: string; mimeType: string; size: number }>
): FileValidationResult {
  // Check total size
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_TOTAL_UPLOAD_SIZE) {
    return {
      valid: false,
      error: `Total upload size exceeds maximum of ${MAX_TOTAL_UPLOAD_SIZE / 1024 / 1024}MB`,
    };
  }

  // Validate each file
  for (const file of files) {
    const result = validateFile(file.filename, file.mimeType, file.size);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}

/**
 * Sanitize a filename to prevent path traversal attacks
 */
export function sanitizeFilename(filename: string): string {
  // Remove path components
  let sanitized = filename.replace(/^.*[\\\/]/, '');

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Replace dangerous characters
  sanitized = sanitized.replace(/[<>:"/\\|?*]/g, '_');

  // Limit length
  if (sanitized.length > 255) {
    const ext = sanitized.substring(sanitized.lastIndexOf('.'));
    sanitized = sanitized.substring(0, 255 - ext.length) + ext;
  }

  // Prevent hidden files
  if (sanitized.startsWith('.')) {
    sanitized = '_' + sanitized;
  }

  return sanitized || 'unnamed_file';
}
