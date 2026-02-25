# Support Desk

A lightweight helpdesk application for managing customer service emails for print-on-demand stores. Features email integration with Zoho Mail, Shopify customer context, Printify order tracking, and AI-powered reply suggestions using Claude.

## Features

- **Shared Inbox**: Pull customer emails into a shared inbox with IMAP sync
- **Social Comments**: Manage Facebook and Instagram comments in one place
- **Shopify Integration**: View customer profiles, order history, and fulfillment status
- **Printify Integration**: Match orders and view production/tracking status
- **AI Suggested Replies**: Generate draft responses using Claude with brand voice
- **Team Collaboration**: Multiple agents with role-based permissions (Admin/Agent)
- **Email Threading**: Proper conversation threading using email headers
- **Automation Rules**: Auto-hide, delete, or label social comments based on keywords

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React, TailwindCSS
- **Backend**: Next.js API Routes, TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: NextAuth.js with credentials provider
- **Email**: Zoho IMAP/SMTP via node-imap and nodemailer
- **AI**: Anthropic Claude API

## Prerequisites

- Node.js 18+
- PostgreSQL database
- Zoho Mail account with IMAP/SMTP enabled
- Shopify store with Admin API access
- Printify account (optional)
- Anthropic API key

## Quick Start

### 1. Clone and install dependencies

```bash
cd support-desk
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your database and secret values
```

**Required environment variables:**

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `NEXTAUTH_URL` | Your app URL (http://localhost:3000 for dev) |
| `NEXTAUTH_SECRET` | Random string for session encryption |
| `ENCRYPTION_KEY` | 64 hex chars for encrypting credentials |

Generate secrets:
```bash
# NextAuth secret
openssl rand -base64 32

# Encryption key
openssl rand -hex 32
```

### 3. Set up database

```bash
# Create database
createdb support_desk

# Run migrations
npx prisma migrate dev

# Generate Prisma client
npx prisma generate
```

### 4. Create initial admin user

```bash
# Use Prisma Studio or a seed script
npx prisma studio
# Navigate to User table and create:
# - email: admin@example.com
# - name: Admin
# - passwordHash: (use bcrypt to hash your password)
# - role: ADMIN
```

Or create a seed script:

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('your-password', 12);

  await prisma.user.create({
    data: {
      email: 'admin@example.com',
      name: 'Admin User',
      passwordHash,
      role: 'ADMIN',
    },
  });
}

main();
```

### 5. Start development server

```bash
npm run dev
```

Visit http://localhost:3000 and log in with your admin credentials.

## Configuring Integrations

All integrations are configured through the admin UI at `/admin/integrations`.

### Zoho Mail (IMAP/SMTP)

1. **Enable IMAP/SMTP in Zoho**:
   - Go to Zoho Mail > Settings > Mail Accounts
   - Select your email > IMAP Access
   - Enable IMAP and SMTP

2. **Create App Password**:
   - Go to Zoho Accounts > Security > App Passwords
   - Generate a new password for "IMAP/SMTP"

3. **Configure in Support Desk**:
   - Go to Admin > Integrations > Zoho Email
   - Enter your email and app password
   - Use defaults for hosts/ports (imap.zoho.com:993, smtp.zoho.com:465)

### Shopify

1. **Create a Custom App**:
   - Go to Shopify Admin > Settings > Apps and sales channels
   - Click "Develop apps" > "Create an app"
   - Configure Admin API scopes: `read_customers`, `read_orders`
   - Install the app and copy the Admin API access token

2. **Configure in Support Desk**:
   - Go to Admin > Integrations > Shopify
   - Enter your store domain (e.g., `your-store.myshopify.com`)
   - Enter the Admin API access token

### Printify

1. **Get API Token**:
   - Go to Printify > Account > API
   - Generate an API token

2. **Find Shop ID**:
   - Your shop ID is in the URL when viewing your shop
   - Or use the Printify API to list shops

3. **Configure in Support Desk**:
   - Go to Admin > Integrations > Printify
   - Enter your API token and shop ID

### Claude AI

1. **Get API Key**:
   - Go to https://console.anthropic.com/
   - Create an API key

2. **Configure in Support Desk**:
   - Go to Admin > Integrations > Claude AI
   - Enter your API key
   - Select model (Sonnet recommended)

### Meta (Facebook/Instagram) Social Comments

Connect your Facebook Pages and Instagram Business accounts to manage comments.

#### 1. Create a Meta Developer App

1. **Create a Meta App**:
   - Go to https://developers.facebook.com/
   - Click "My Apps" > "Create App"
   - Select "Business" type
   - Fill in app details

2. **Add Facebook Login Product**:
   - In your app dashboard, click "Add Product"
   - Add "Facebook Login for Business"

3. **Configure OAuth Settings**:
   - Go to Facebook Login > Settings
   - Add Valid OAuth Redirect URI: `https://your-domain.com/admin/social`
   - Add `https://localhost:3000/admin/social` for development

4. **Set App Permissions**:
   Required permissions for comment management:
   - `pages_show_list` - List your Pages
   - `pages_read_engagement` - Read comments
   - `pages_manage_engagement` - Reply, like, hide comments
   - `instagram_basic` - Instagram business account info
   - `instagram_manage_comments` - Instagram comment management

5. **Get App Credentials**:
   - Go to Settings > Basic
   - Copy the App ID and App Secret

#### 2. Configure Environment Variables

Add to your `.env`:

```bash
# Meta OAuth
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
META_REDIRECT_URI=http://localhost:3000/admin/social/callback
META_WEBHOOK_VERIFY_TOKEN=a_random_string_you_choose
```

**Important:** The `META_REDIRECT_URI` must match exactly what you configured in your Meta App's OAuth settings. For production, use your actual domain: `https://your-domain.com/admin/social/callback`

#### 3. Connect in Support Desk

1. Go to Admin > Social Settings
2. Click "Connect with Facebook"
3. Authorize the app and select your Pages
4. Your connected accounts will appear in the list

#### 4. Set Up Webhooks (Optional - for Real-time Updates)

For real-time comment notifications:

1. **Configure Webhook in Meta App**:
   - Go to your Meta App > Webhooks
   - Click "Add Subscription" for "Page"
   - Callback URL: `https://your-domain.com/api/social/webhook`
   - Verify Token: Use the same value as `META_WEBHOOK_VERIFY_TOKEN`

2. **Subscribe to Events**:
   - `feed` - Post comments on Facebook
   - `mentions` - Instagram mentions (if needed)

3. **App Review** (for Production):
   - Submit your app for review to access real user data
   - Required for Live mode with non-test users

#### 5. Automation Rules

Set up rules to auto-moderate comments:

1. Go to Admin > Social Settings
2. Click "Create Rule"
3. Configure:
   - **Name**: Rule identifier
   - **Platforms**: Facebook, Instagram, or both
   - **Keywords**: Comma-separated words to match
   - **Action**: Hide, delete, or add label
   - **Dry Run**: Test without taking action

Example rules:
- Auto-hide spam comments with URLs
- Auto-delete profanity
- Flag questions for review

## Email Sync

Emails are synced automatically via a background process or manually triggered.

### Manual Sync

Click "Sync Now" in Admin > Mailbox to trigger an immediate sync.

### Background Worker

For production, run the sync worker as a separate process:

```bash
# Start the worker
npx ts-node src/workers/email-sync.ts
```

Or use a process manager like PM2:

```bash
pm2 start src/workers/email-sync.ts --name email-sync
```

## Architecture

### Email Provider Interface

The email layer is designed as a provider interface for extensibility:

```typescript
interface EmailProvider {
  testConnection(): Promise<{ success: boolean; error?: string }>;
  syncNewMessages(state: SyncState): Promise<SyncResult>;
  getThreadMessages(threadKey: string): Promise<EmailMessage[]>;
  sendMessage(params: SendMessageParams): Promise<SendResult>;
  groupIntoThreads(messages: EmailMessage[]): EmailThread[];
  disconnect(): Promise<void>;
}
```

Currently implemented:
- `ZohoImapSmtpProvider` - IMAP for reading, SMTP for sending

Future providers:
- `ZohoApiProvider` - Zoho Mail API (when available)

### Data Model

```
User             - Team members (Admin, Agent)
Mailbox          - Email accounts to sync
Thread           - Conversation threads
Message          - Individual emails
Attachment       - Email attachment metadata
CustomerLink     - Cached Shopify customer data
OrderLink        - Shopify-Printify order mapping
IntegrationSettings - Encrypted credentials
SyncJob          - Email sync history

# Social Comments
SocialAccount    - Connected Facebook/Instagram accounts
SocialObject     - Posts/Ads that have comments
SocialComment    - Individual comments
SocialRule       - Automation rules
SocialRuleRun    - Rule execution history
SocialActionLog  - Audit log of all actions
SocialSyncJob    - Comment sync history
```

### Security

- All integration credentials encrypted at rest with AES-256-GCM
- Role-based access control on all API routes
- Passwords never logged
- Session-based authentication with JWT

## Development

### Project Structure

```
support-desk/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── (dashboard)/        # Authenticated routes
│   │   │   ├── inbox/          # Email inbox view
│   │   │   ├── social/         # Social comments view
│   │   │   └── admin/          # Admin pages
│   │   ├── api/                # API routes
│   │   │   ├── social/         # Social comments APIs
│   │   │   └── ...             # Other APIs
│   │   └── login/              # Login page
│   ├── components/             # React components
│   │   ├── inbox/              # Inbox list
│   │   ├── thread/             # Thread view
│   │   ├── social/             # Social comment components
│   │   ├── sidebar/            # Customer sidebar
│   │   └── ui/                 # Shared UI components
│   ├── lib/                    # Business logic
│   │   ├── auth/               # NextAuth config
│   │   ├── claude/             # AI suggestion service
│   │   ├── db/                 # Prisma client
│   │   ├── email/              # Email providers
│   │   ├── encryption/         # Credential encryption
│   │   ├── printify/           # Printify API client
│   │   ├── shopify/            # Shopify API client
│   │   └── social/             # Meta API & rules engine
│   └── workers/                # Background processes
├── prisma/
│   └── schema.prisma           # Database schema
└── package.json
```

### Adding a New Email Provider

1. Implement the `EmailProvider` interface in `src/lib/email/`
2. Add configuration type to `src/lib/email/types.ts`
3. Update `createEmailProvider()` factory function
4. Add integration type to Prisma schema if needed

## Roadmap

### MVP (Current)
- [x] Zoho IMAP/SMTP email sync
- [x] Shopify customer/order context
- [x] Printify order matching
- [x] Claude suggested replies
- [x] Team management (Admin/Agent roles)
- [x] Basic inbox/thread UI
- [x] Facebook/Instagram comment management
- [x] Social comment automation rules

### Future
- [ ] Zoho Mail API integration
- [ ] Canned responses / macros
- [ ] Ticket assignment rules
- [ ] Email templates
- [ ] Analytics dashboard
- [ ] Slack notifications
- [ ] Customer satisfaction surveys
- [ ] AI-powered comment suggestions

## License

MIT
