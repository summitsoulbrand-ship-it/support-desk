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

interface InlineImage {
  cid: string;
  filename: string;
  content: Buffer;
  contentType: string;
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
   * Extract base64 images from HTML and convert to CID references
   * Returns modified HTML and list of inline images
   */
  private extractInlineImages(html: string): { html: string; inlineImages: InlineImage[] } {
    const inlineImages: InlineImage[] = [];
    let imageCounter = 0;

    // Match base64 image sources: src="data:image/...;base64,..."
    const base64Regex = /src=["']data:(image\/[^;]+);base64,([^"']+)["']/gi;

    const modifiedHtml = html.replace(base64Regex, (match, mimeType: string, base64Data: string) => {
      imageCounter++;
      const cid = `inline-image-${imageCounter}-${Date.now()}`;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image-${imageCounter}.${extension}`;

      // Decode base64 to Buffer
      const content = Buffer.from(base64Data, 'base64');

      inlineImages.push({
        cid,
        filename,
        content,
        contentType: mimeType,
      });

      console.log(`[Zoho] Extracted inline image: ${filename} (${content.length} bytes, ${mimeType})`);

      // Replace with CID reference
      return `src="cid:${cid}"`;
    });

    return { html: modifiedHtml, inlineImages };
  }

  /**
   * Upload an attachment to Zoho Mail (required before sending)
   * Returns the attachmentPath to reference in the email
   */
  private async uploadAttachment(
    attachment: { filename: string; content: Buffer; contentType?: string },
    isInline: boolean = false,
    cid?: string
  ): Promise<{ attachmentPath: string; storeName: string; cid?: string } | null> {
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

      console.log(`[Zoho] Uploading attachment: ${attachment.filename} (${attachment.content.length} bytes, type: ${attachment.contentType || 'application/octet-stream'})`);

      const uploadUrl = `${this.getBaseUrl()}/accounts/${this.config.accountId}/messages/attachments?uploadType=multipart`;
      console.log(`[Zoho] Upload URL: ${uploadUrl}`);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
        },
        body: formData,
      });

      const responseText = await response.text();
      console.log(`[Zoho] Upload response status: ${response.status}`);
      console.log(`[Zoho] Upload response body: ${responseText}`);

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        console.error('[Zoho] Failed to parse upload response as JSON:', responseText);
        return null;
      }

      if (!response.ok) {
        console.error(`[Zoho] Upload failed with HTTP ${response.status}:`, result);
        return null;
      }

      if (result.status?.code !== 200) {
        console.error(`[Zoho] Upload failed with API error:`, result.status);
        return null;
      }

      const data = result.data;
      if (!data?.attachmentPath) {
        console.error('[Zoho] Upload succeeded but no attachmentPath returned:', result);
        return null;
      }

      console.log(`[Zoho] Attachment uploaded successfully: ${attachment.filename} -> ${data.attachmentPath}${isInline ? ' (inline)' : ''}`);
      return {
        attachmentPath: data.attachmentPath,
        storeName: data.storeName || attachment.filename,
        cid: isInline ? cid : undefined,
      };
    } catch (err) {
      console.error('[Zoho] Error uploading attachment:', err instanceof Error ? err.message : err);
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

      // Process HTML content - extract inline base64 images
      let processedHtml = params.bodyHtml;
      let inlineImages: InlineImage[] = [];

      if (params.bodyHtml) {
        const extracted = this.extractInlineImages(params.bodyHtml);
        processedHtml = extracted.html;
        inlineImages = extracted.inlineImages;

        if (inlineImages.length > 0) {
          console.log(`[Zoho] Extracted ${inlineImages.length} inline image(s) from HTML`);
        }

        emailPayload.content = processedHtml;
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
        inlineImages: inlineImages.length,
      });

      // Collect all attachments (regular + inline images)
      const uploadedAttachments: { storeName: string; attachmentPath: string; isInline?: boolean; cid?: string }[] = [];

      // Upload inline images first
      for (const img of inlineImages) {
        console.log(`[Zoho] Uploading inline image: ${img.filename} (${img.contentType}, ${img.content.length} bytes, cid: ${img.cid})`);
        const uploaded = await this.uploadAttachment(
          { filename: img.filename, content: img.content, contentType: img.contentType },
          true,
          img.cid
        );
        if (uploaded) {
          uploadedAttachments.push({
            storeName: uploaded.storeName,
            attachmentPath: uploaded.attachmentPath,
            isInline: true,
            cid: img.cid,
          });
          console.log(`[Zoho] Successfully uploaded inline image: ${img.filename} -> ${uploaded.attachmentPath}`);
        } else {
          console.error(`[Zoho] Failed to upload inline image: ${img.filename}`);
        }
      }

      // Handle regular attachments if present
      if (params.attachments && params.attachments.length > 0) {
        console.log(`Processing ${params.attachments.length} regular attachment(s)...`);

        for (const att of params.attachments) {
          console.log(`Uploading attachment: ${att.filename} (${att.contentType}, ${att.content.length} bytes)`);
          const uploaded = await this.uploadAttachment(att, false);
          if (uploaded) {
            uploadedAttachments.push({
              storeName: uploaded.storeName,
              attachmentPath: uploaded.attachmentPath,
            });
            console.log(`Successfully uploaded: ${att.filename} -> ${uploaded.attachmentPath}`);
          } else {
            console.error(`Failed to upload attachment: ${att.filename}`);
            // Continue with other attachments rather than failing completely
          }
        }
      }

      if (uploadedAttachments.length > 0) {
        emailPayload.attachments = uploadedAttachments;
        console.log('Using attachments:', JSON.stringify(uploadedAttachments, null, 2));
      }

      console.log('[Zoho] Sending email with payload:', JSON.stringify({
        ...emailPayload,
        content: emailPayload.content ? `${String(emailPayload.content).substring(0, 100)}...` : undefined,
      }, null, 2));

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

      const responseText = await response.text();
      console.log(`[Zoho] Send response status: ${response.status}`);
      console.log(`[Zoho] Send response body: ${responseText}`);

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        console.error('[Zoho] Failed to parse send response as JSON:', responseText);
        return { success: false, error: `Invalid response: ${responseText.substring(0, 200)}` };
      }

      if (!response.ok || result.status?.code !== 200) {
        const errorMsg = result.status?.description || result.data?.errorCode || 'Unknown error';
        console.error('[Zoho] Send failed:', result);
        return { success: false, error: errorMsg };
      }

      const messageId = result.data?.messageId;
      console.log('[Zoho] Email sent successfully:', { messageId });

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
