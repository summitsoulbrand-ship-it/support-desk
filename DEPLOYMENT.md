# Support Desk - Production Deployment Guide

## Prerequisites

- Node.js 20+ (for local builds)
- Docker and Docker Compose (for containerized deployment)
- PostgreSQL 15+ database
- Redis (optional, for background jobs)

## Deployment Options

### Option 1: Docker Compose (Recommended for VPS/Self-hosted)

1. **Clone and configure:**
   ```bash
   git clone <your-repo>
   cd support-desk
   cp .env.production.example .env.production
   ```

2. **Edit `.env.production`** with your production values:
   - `NEXTAUTH_URL` - Your production domain (e.g., `https://support.yourdomain.com`)
   - `NEXTAUTH_SECRET` - Generate with `openssl rand -base64 32`
   - `ENCRYPTION_KEY` - Generate with `openssl rand -hex 32`
   - `POSTGRES_PASSWORD` - Secure database password

3. **Build and start:**
   ```bash
   docker-compose --env-file .env.production up -d
   ```

4. **Run database migrations:**
   ```bash
   docker-compose exec app npx prisma migrate deploy
   ```

5. **Create initial admin user:**
   ```bash
   docker-compose exec app npx prisma db seed
   ```

### Option 2: Vercel (Serverless)

1. **Connect your repository** to Vercel

2. **Configure environment variables** in Vercel dashboard:
   - `DATABASE_URL` - Use a managed PostgreSQL (Supabase, Neon, Railway)
   - `NEXTAUTH_URL` - Your Vercel domain
   - `NEXTAUTH_SECRET` - Generate secure secret
   - `ENCRYPTION_KEY` - Generate 64-char hex key

3. **Deploy** - Vercel will automatically build and deploy

4. **Run migrations** (one-time):
   ```bash
   npx prisma migrate deploy
   ```

### Option 3: Railway / Render

Both platforms support automatic deployments from Git.

1. Create a new project and connect your repository
2. Add PostgreSQL and Redis services
3. Configure environment variables
4. Deploy

## Post-Deployment Setup

### 1. Database Migrations

Always run migrations after deployment:
```bash
npx prisma migrate deploy
```

### 2. Create Admin User

The seed script creates a default admin:
- Email: `admin@example.com`
- Password: `admin123`

**Change this immediately after first login!**

### 3. Configure Integrations

In the admin UI (`/admin/integrations`), configure:
- **Email** - Zoho Mail credentials for IMAP/SMTP
- **Shopify** - Store domain and access token
- **Printify** - API token and shop ID
- **Claude** - Anthropic API key for AI suggestions
- **Meta** - For Facebook/Instagram comment management

## Background Worker (recommended)

The background worker (`src/workers/main.ts`) runs four loops:
- Email sync every 90s (no more manual Sync button waits)
- AI triage + reply pre-drafting every 20s
- Printify order sync every 10 min
- Carrier tracking refresh for open threads every 30 min

### Railway (recommended setup)

Add a SECOND service to the existing Railway project, from the same GitHub repo:

1. Railway dashboard → the project → **New** → **GitHub Repo** → pick `support-desk` again
2. On the new service, set variable `RAILWAY_DOCKERFILE_PATH=Dockerfile.worker` so it builds the worker image instead of the web app
3. Set these variables on the worker service:
   - `DATABASE_URL` - reference the existing Postgres service (`${{Postgres.DATABASE_URL}}`)
   - `ENCRYPTION_KEY` - MUST be identical to the web service's value (integration credentials are decrypted from the DB)
   - `SYNC_INTERVAL=90000` (optional, default 90s)
   - `TRACKING_TTL_HOURS=4` (optional)
   - `ANTHROPIC_API_KEY` (optional fallback; normally read from integration settings)
4. Deploy. Logs should show `[worker] Starting Support Desk background worker` and the loop intervals.

The web app's browser auto-sync detects the worker heartbeat (mailbox lastSyncAt) and steps aside automatically; the manual Sync button still forces a real sync.

### Option B: Docker worker container
```bash
docker-compose --profile worker up -d
```

### Option C: External cron job
```bash
# Add to crontab (runs every 2 minutes)
*/2 * * * * curl -X POST https://your-domain.com/api/sync -H "Authorization: Bearer $CRON_SECRET"
```

## Backup Strategy

### Automated backups
Configure the cron endpoint for daily backups:
```bash
# Daily backup at 2 AM
0 2 * * * curl -X POST https://your-domain.com/api/cron/backup -H "Authorization: Bearer $CRON_SECRET"
```

### Manual backup
```bash
docker-compose exec postgres pg_dump -U supportdesk support_desk > backup.sql
```

## SSL/HTTPS

For production, always use HTTPS:
- **Vercel/Railway/Render**: SSL is automatic
- **Self-hosted**: Use a reverse proxy (nginx, Caddy) with Let's Encrypt

Example nginx config:
```nginx
server {
    listen 443 ssl http2;
    server_name support.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/support.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/support.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Monitoring

### Health check endpoint
```bash
curl https://your-domain.com/api/auth/session
```

### Docker logs
```bash
docker-compose logs -f app
```

## Troubleshooting

### Database connection issues
- Verify `DATABASE_URL` format and credentials
- Ensure PostgreSQL allows connections from your app
- Check SSL requirements (`?sslmode=require`)

### Email sync not working
- Verify Zoho credentials in admin UI
- Check IMAP is enabled in Zoho Mail settings
- Review logs for connection errors

### AI suggestions failing
- Verify Anthropic API key is valid
- Check API rate limits
- Review Claude configuration in admin UI
