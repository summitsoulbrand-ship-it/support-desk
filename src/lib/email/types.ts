/**
 * Email provider types and interfaces
 * Designed to support multiple providers (Zoho IMAP/SMTP, Zoho API, etc.)
 */

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  content?: Buffer; // Optional for MVP
}

export interface EmailMessage {
  messageId: string;
  uid?: number; // IMAP UID
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  date: Date;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachment[];
}

export interface EmailThread {
  threadKey: string;
  subject: string;
  messages: EmailMessage[];
  lastMessageAt: Date;
  customerEmail: string;
  customerName?: string;
}

export interface SyncState {
  lastSyncAt?: Date;
  lastSyncUid?: number;
  uidValidity?: number;
  cursor?: string;
}

export interface SendMessageAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendMessageParams {
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: SendMessageAttachment[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface SyncResult {
  newMessages: EmailMessage[];
  syncState: SyncState;
  error?: string;
}

/**
 * Email provider interface
 * All email providers must implement this interface
 */
export interface EmailProvider {
  /**
   * Provider identifier
   */
  readonly providerType: string;

  /**
   * Test connection to the email provider
   */
  testConnection(): Promise<{ success: boolean; error?: string }>;

  /**
   * Sync new messages since last sync
   */
  syncNewMessages(state: SyncState): Promise<SyncResult>;

  /**
   * Get all messages for a specific thread
   */
  getThreadMessages(threadKey: string): Promise<EmailMessage[]>;

  /**
   * Send an email message
   */
  sendMessage(params: SendMessageParams): Promise<SendResult>;

  /**
   * Group messages into threads
   * Uses Message-ID, In-Reply-To, References headers
   * Falls back to subject normalization if needed
   */
  groupIntoThreads(messages: EmailMessage[]): EmailThread[];

  /**
   * Disconnect / cleanup
   */
  disconnect(): Promise<void>;
}

/**
 * Configuration for Zoho IMAP/SMTP provider
 */
export interface ZohoImapSmtpConfig {
  // IMAP settings
  imapHost: string;
  imapPort: number;
  imapTls: boolean;

  // SMTP settings
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;

  // Auth
  username: string;
  password: string; // App password recommended

  // Optional
  folder?: string; // Default: INBOX
}
