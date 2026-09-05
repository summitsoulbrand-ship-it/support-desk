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
   - `APP_URL` - the public web app URL (e.g. `https://support.yourdomain.com`); enables Printify shipment-webhook registration for relinked orders
   - `PRINTIFY_WEBHOOK_SECRET` - any random string (`openssl rand -hex 24`); set the SAME value on the web service so the webhook receiver can verify signatures
   - `ANTHROPIC_API_KEY` (optional fallback; normally read from integration settings)
4. Deploy. Logs should show `[worker] Starting Support Desk background worker` and the loop intervals.

### Post-purchase upsell merge (off by default)

A post-purchase upsell app adds the upsold tee to the Shopify order AFTER
payment. Printify snapshots an order at payment and ignores later edits, so
without this the upsold item never prints. The `upsell-merge` worker loop
rebuilds the Printify order every 2 minutes as ONE order carrying every current
line, and leaves it **on hold** so Printify's own nightly sweep prints it - the
hold is what keeps the customer's cancel / address / size-change window open.

Set on the WORKER service:

- `UPSELL_MERGE_ENABLED=true` - the master switch. Off, the loop never starts.
- `UPSELL_ORDER_TAG` - the exact tag the upsell app puts on orders it edits
  (Kaching uses `Kaching Upsell`). **No default on purpose:** a guessed tag
  either matches nothing, or matches too much. Read the real tag off a live
  upsold order before setting this - do not take it from the app's docs.
- `UPSELL_MERGE_DRY_RUN=true` - **run this first.** Everything works out what it
  would do and posts it to Slack, then stops before the first write. Leave it on
  for a day and read what it planned before letting it touch a real order.
- `UPSELL_MAX_TOUCH=8` (optional) - more orders STILL NEEDING a merge than this
  in one sweep means the tagging broke, so the sweep halts and alerts without
  writing. It counts orders that need work, not every tagged order: at ~230
  orders per two days and a 3-5% take rate, 7-11 orders carry the tag at any
  moment, so counting tagged orders would trip on every sweep and merge nothing.
- `UPSELL_SETTLE_MINUTES=10` (optional) - how long an order must sit unchanged
  before it is touched. A customer still on the post-purchase page can accept a
  second offer minutes later, and every rebuild cancels and recreates a real
  Printify order, so it is worth doing once. Each new edit restarts the clock.
- `UPSELL_MAX_SETTLE_MINUTES=60` (optional) - the ceiling on that wait, measured
  from when the order was placed. Other automations here write order tags and a
  tag write bumps the order's updated time, so without a ceiling a chatty
  neighbour could hold an upsell back until it was too late to merge.
- `UPSELL_BLACKOUT_START_UTC=06:50` / `UPSELL_BLACKOUT_END_UTC=07:30` (optional) -
  the merge does not run while Printify's nightly print run is submitting orders,
  because Printify rejects cancellations in that window. On 2026-09-05 a merge at
  07:05 could cancel neither the original nor its own replacement, leaving two
  live orders. Nothing is lost by skipping it: the deadline a merge races IS this
  print run.
- `UPSELL_MAX_MERGES_PER_ORDER=3` (optional) - one order may be rebuilt this
  many times. Merging once is not the end: a second offer or a later order edit
  can add another item, and that has to be picked up too. Past this it is a loop,
  so the bot stops touching that order and says so.
- `UPSELL_MAX_DAILY=30` (optional) - the kill switch. More merges than this in
  24 hours stops the bot outright until a human raises it.
- `UPSELL_LOOKBACK_HOURS=24` (optional) - how far back a sweep looks. Longer than
  a day is pointless: Printify's nightly sweep prints everything older, so those
  orders can only produce alerts nothing can act on.

If the original Printify order is ALREADY PRINTING when the upsell lands, the
missing items ship as their own second box rather than never being made - Pati's
call: a customer who paid for two shirts gets two shirts, even in two parcels.
That add-on cancels nothing, and deliberately does NOT push tracking to Shopify,
because it shares a Shopify order with the main box and pushing would overwrite
the main box's tracking number. Its Printify id is reported in Slack instead.

Nothing is ever sent to print for an order with an unpaid balance. A
post-purchase upsell charges the saved card immediately, so an outstanding
balance means the charge did not land.

If the upsold item arrives as its OWN second Printify order rather than being
ignored, the merge folds both into one - nothing is missing, but the customer
would otherwise get two boxes and two tracking numbers for one order. It refuses
to do that when one of the copies is a tracked replacement or reroute, or when
the copies together hold an item Shopify no longer wants.

Slack, on the WEB and WORKER services both:

- `SLACK_UPSELL_WEBHOOK_URL` - the upsells channel. Every merge lands here, and
  so does every upsell that failed. If it is unset the messages fall back to the
  self-service monitor channel rather than vanishing.

A failed merge ALSO shouts in #escalations and emails support@, because it means
an item the customer paid for will not ship.

When the circuit breaker or the kill switch trips, merging STOPS. That is said
plainly in the alert, repeated every 6 hours for as long as it stays stopped,
and followed by an "all clear" line once merging resumes - a one-off warning
scrolled past on a Friday would otherwise mean a week of upsells shipping short.

A heartbeat posts once a day whether or not anything happened
(`UPSELL_HEARTBEAT_HOUR_MANILA=21`), so a worker that died, a flag switched off,
or a loop that never started shows up as a missing daily line instead of looking
exactly like a quiet day.


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
