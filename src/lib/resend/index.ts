/**
 * Resend email client for sending outbound emails
 * Uses Resend's HTTP API which works on Railway (unlike SMTP)
 */

import { Resend } from 'resend';

export interface ResendConfig {
  apiKey: string;
  fromEmail: string;  // e.g., support@yourdomain.com
  fromName?: string;  // e.g., "Summit Soul Support"
}

export interface SendEmailParams {
  to: { address: string; name?: string }[];
  cc?: { address: string; name?: string }[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: {
    filename: string;
    content: Buffer;
    contentType?: string;
  }[];
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class ResendClient {
  private client: Resend;
  private config: ResendConfig;

  constructor(config: ResendConfig) {
    this.config = config;
    this.client = new Resend(config.apiKey);
  }

  /**
   * Test the connection by checking the API key
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      // Try to get domains - this validates the API key
      const { data, error } = await this.client.domains.list();

      if (error) {
        return { success: false, error: error.message };
      }

      console.log('Resend connection successful, domains:', data?.data?.length || 0);
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error };
    }
  }

  /**
   * Send an email via Resend
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      const from = this.config.fromName
        ? `${this.config.fromName} <${this.config.fromEmail}>`
        : this.config.fromEmail;

      const to = params.to.map(t =>
        t.name ? `${t.name} <${t.address}>` : t.address
      );

      const cc = params.cc?.map(c =>
        c.name ? `${c.name} <${c.address}>` : c.address
      );

      // Build headers for email threading
      const headers: Record<string, string> = {};
      if (params.inReplyTo) {
        headers['In-Reply-To'] = params.inReplyTo;
      }
      if (params.references && params.references.length > 0) {
        headers['References'] = params.references.join(' ');
      }

      console.log('Sending email via Resend:', {
        from,
        to,
        subject: params.subject,
      });

      // Ensure we have at least text content if no html
      const htmlContent = params.bodyHtml;
      const textContent = params.bodyText || (params.bodyHtml ? undefined : '');

      const { data, error } = await this.client.emails.send({
        from,
        to,
        ...(cc && cc.length > 0 ? { cc } : {}),
        subject: params.subject,
        ...(htmlContent ? { html: htmlContent } : {}),
        ...(textContent ? { text: textContent } : { text: '' }),
        replyTo: params.replyTo || this.config.fromEmail,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(params.attachments && params.attachments.length > 0 ? {
          attachments: params.attachments.map(att => ({
            filename: att.filename,
            content: att.content,
            contentType: att.contentType,
          })),
        } : {}),
      });

      if (error) {
        console.error('Resend error:', error);
        return { success: false, error: error.message };
      }

      console.log('Resend send result:', { messageId: data?.id });

      return {
        success: true,
        messageId: data?.id,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      console.error('Resend send error:', error);
      return { success: false, error };
    }
  }
}
