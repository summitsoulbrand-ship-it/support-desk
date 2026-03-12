/**
 * Zoho Mail API client for sending outbound emails via HTTP
 * Uses OAuth2 for authentication - works on Railway (no SMTP blocking)
 */

export interface ZohoMailApiConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  fromEmail: string;
  fromName?: string;
  // Zoho data center - defaults to .com
  dataCenter?: 'com' | 'eu' | 'in' | 'com.au' | 'jp';
}

export interface SendEmailParams {
  to: { address: string; name?: string }[];
  cc?: { address: string; name?: string }[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
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

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
}

export class ZohoMailApiClient {
  private config: ZohoMailApiConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: ZohoMailApiConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    const dc = this.config.dataCenter || 'com';
    return `https://mail.zoho.${dc}/api`;
  }

  /**
   * Upload an attachment to Zoho Mail (required before sending)
   * Returns the attachmentPath to reference in the email
   */
  private async uploadAttachment(
    attachment: { filename: string; content: Buffer; contentType?: string }
  ): Promise<{ attachmentPath: string; storeName: string } | null> {
    try {
      const token = await this.refreshAccessToken();

      // Create form data for multipart upload
      const formData = new FormData();
      // Convert Buffer to Uint8Array for Blob compatibility
      const uint8Array = new Uint8Array(attachment.content);
      const blob = new Blob([uint8Array], {
        type: attachment.contentType || 'application/octet-stream',
      });
      formData.append('attach', blob, attachment.filename);

      const response = await fetch(
        `${this.getBaseUrl()}/accounts/${this.config.accountId}/messages/attachments?uploadType=multipart`,
        {
          method: 'POST',
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
          },
          body: formData,
        }
      );

      const result = await response.json();
      console.log('Zoho attachment upload response:', JSON.stringify(result, null, 2));

      if (!response.ok || result.status?.code !== 200) {
        console.error('Zoho attachment upload failed:', result);
        return null;
      }

      const data = result.data;
      console.log('Zoho attachment uploaded successfully:', {
        attachmentPath: data.attachmentPath,
        storeName: data.storeName,
      });
      return {
        attachmentPath: data.attachmentPath,
        storeName: data.storeName || attachment.filename,
      };
    } catch (err) {
      console.error('Error uploading attachment to Zoho:', err);
      return null;
    }
  }

  private getAuthUrl(): string {
    const dc = this.config.dataCenter || 'com';
    return `https://accounts.zoho.${dc}/oauth/v2/token`;
  }

  /**
   * Refresh the access token using the refresh token
   */
  private async refreshAccessToken(): Promise<string> {
    // Check if current token is still valid (with 5 min buffer)
    if (this.accessToken && Date.now() < this.tokenExpiry - 300000) {
      return this.accessToken;
    }

    console.log('Refreshing Zoho access token...');

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(this.getAuthUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data: TokenResponse = await response.json();

    if (data.error || !data.access_token) {
      throw new Error(`Failed to refresh token: ${data.error || 'No access token returned'}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in * 1000);

    console.log('Zoho access token refreshed successfully');
    return this.accessToken;
  }

  /**
   * List all available mail accounts (useful for finding the Account ID)
   */
  async listAccounts(): Promise<{ accountId: string; emailAddress: string }[]> {
    const token = await this.refreshAccessToken();

    const response = await fetch(`${this.getBaseUrl()}/accounts`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const accounts = data.data || [];
    return accounts.map((acc: { accountId: string; emailAddress: string }) => ({
      accountId: acc.accountId,
      emailAddress: acc.emailAddress,
    }));
  }

  /**
   * Test the connection by getting account info
   */
  async testConnection(): Promise<{ success: boolean; error?: string; availableAccounts?: { accountId: string; emailAddress: string }[] }> {
    try {
      const token = await this.refreshAccessToken();

      // Try to get account info
      const response = await fetch(
        `${this.getBaseUrl()}/accounts/${this.config.accountId}`,
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
          },
        }
      );

      if (!response.ok) {
        const text = await response.text();

        // If account not found, try to list available accounts
        if (text.includes('Account not exists') || response.status === 500) {
          const availableAccounts = await this.listAccounts();
          if (availableAccounts.length > 0) {
            return {
              success: false,
              error: `Account ID "${this.config.accountId}" not found. Available accounts: ${availableAccounts.map(a => `${a.emailAddress} (ID: ${a.accountId})`).join(', ')}`,
              availableAccounts
            };
          }
        }

        return { success: false, error: `API error: ${response.status} - ${text}` };
      }

      const data = await response.json();
      console.log('Zoho Mail API connection successful:', data.data?.emailAddress);
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      console.error('Zoho Mail API test failed:', error);
      return { success: false, error };
    }
  }

  /**
   * Send an email via Zoho Mail API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      const token = await this.refreshAccessToken();

      // Format recipients
      const toAddress = params.to
        .map(t => t.name ? `"${t.name}" <${t.address}>` : t.address)
        .join(',');

      const ccAddress = params.cc
        ?.map(c => c.name ? `"${c.name}" <${c.address}>` : c.address)
        .join(',');

      // Build from address
      const fromAddress = this.config.fromName
        ? `"${this.config.fromName}" <${this.config.fromEmail}>`
        : this.config.fromEmail;

      // Build email payload
      const emailPayload: Record<string, unknown> = {
        fromAddress,
        toAddress,
        subject: params.subject,
        mailFormat: 'html',
      };

      if (ccAddress) {
        emailPayload.ccAddress = ccAddress;
      }

      if (params.bodyHtml) {
        emailPayload.content = params.bodyHtml;
      } else if (params.bodyText) {
        emailPayload.content = params.bodyText;
        emailPayload.mailFormat = 'plaintext';
      }

      // Add threading headers if replying
      if (params.inReplyTo) {
        emailPayload.inReplyTo = params.inReplyTo;
      }

      console.log('Sending email via Zoho Mail API:', {
        from: fromAddress,
        to: toAddress,
        subject: params.subject,
      });

      // Handle attachments if present
      if (params.attachments && params.attachments.length > 0) {
        // Try upload method first
        const uploadedAttachments: { storeName: string; attachmentPath: string }[] = [];
        let uploadFailed = false;

        for (const att of params.attachments) {
          const uploaded = await this.uploadAttachment(att);
          if (uploaded) {
            uploadedAttachments.push({
              storeName: uploaded.storeName,
              attachmentPath: uploaded.attachmentPath,
            });
          } else {
            console.warn(`Upload failed for ${att.filename}, trying inline method`);
            uploadFailed = true;
            break;
          }
        }

        if (!uploadFailed && uploadedAttachments.length > 0) {
          emailPayload.attachments = uploadedAttachments;
          console.log('Using uploaded attachments:', JSON.stringify(uploadedAttachments, null, 2));
        } else {
          // Fallback: try inline base64 with correct Zoho format
          console.log('Falling back to inline attachments');
          emailPayload.attachments = params.attachments.map(att => ({
            storeName: att.filename,
            attachmentName: att.filename,
            attachmentContent: att.content.toString('base64'),
            mimeType: att.contentType || 'application/octet-stream',
          }));
          console.log('Using inline attachments for:', params.attachments.map(a => a.filename));
        }
      }

      console.log('Sending with attachments:', emailPayload.attachments ? 'yes' : 'no');

      const response = await fetch(
        `${this.getBaseUrl()}/accounts/${this.config.accountId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(emailPayload),
        }
      );

      const result = await response.json();

      if (!response.ok || result.status?.code !== 200) {
        const errorMsg = result.status?.description || result.data?.errorCode || 'Unknown error';
        console.error('Zoho Mail API error:', result);
        return { success: false, error: errorMsg };
      }

      const messageId = result.data?.messageId;
      console.log('Zoho Mail API send result:', { messageId });

      return {
        success: true,
        messageId,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error';
      console.error('Zoho Mail API send error:', error);
      return { success: false, error };
    }
  }
}

/**
 * Exchange authorization code for refresh token
 * This is a one-time operation during setup
 */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  dataCenter: string = 'com'
): Promise<{ refreshToken?: string; error?: string }> {
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    });

    const response = await fetch(`https://accounts.zoho.${dataCenter}/oauth/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await response.json();

    if (data.error || !data.refresh_token) {
      return { error: data.error || 'No refresh token returned' };
    }

    return { refreshToken: data.refresh_token };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { error };
  }
}
