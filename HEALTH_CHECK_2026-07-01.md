# Support Desk Health Check - 2026-07-01

Full audit by Claude (4 parallel deep reviews: UI/UX, frontend performance, backend correctness/security, architecture/overlap). Baseline: typecheck clean, 85/85 tests pass, lint 51 errors / 80 warnings (mostly unused vars), 11 npm vulns (mostly next-auth transitive).

Overall verdict: well-engineered for its size. Self-service token design, Printify sync (contentHash, retry/backoff), Meta rate-limit discipline, and the AI draft claim/orphan-recovery logic are all above average. The risks cluster in a few unauthenticated surfaces, two silent-failure modes, and unevenly applied UX patterns (the good ideas exist in the repo, just not everywhere).

---

## A. Fix first - security and silent failures

1. **Backups have not run since Feb 24 + auth bypass.** The backup cron lives in `vercel.json` but the app deploys on Railway, so it never fires. Worse, `src/app/api/cron/backup/route.ts:110-117` trusts a spoofable `x-vercel-cron` header, so any anonymous client can trigger pg_dump (DoS + old-backup deletion). Fix: require `Bearer ${CRON_SECRET}` unconditionally, fail closed if unset, and add a Railway cron for the endpoint (or delete the subsystem).
2. **Meta client has no fetch timeout** (`src/lib/social/meta-client.ts:157`). One hung Graph call wedges a worker loop's `running` flag forever (social-sync / messenger-sync / comment-drafts dead until redeploy, silently). Every other client has a timeout (Shopify 10s, TrackingMore 8s, Printify 20s+retry). Fix: `AbortSignal.timeout(~15000)`.
3. **IMAP UIDVALIDITY change silently drops mail** (`src/lib/email/zoho-imap-provider.ts:396-433`). After a mailbox rebuild the SINCE fallback still filters `uid > lastSyncUid` with the old-namespace UID, so new customer emails are dropped permanently, no error, no self-heal. Fix: only apply the UID filter when uidValidity matches; reset `lastSyncUid` on mismatch.
4. **Stored XSS via email attachments** (`src/app/api/attachments/[id]/route.ts:56-64`, `src/lib/upload-security.ts:19,36`). SVG (and text/html) from inbound customer email is served same-origin with `Content-Disposition: inline`; embedded script runs as the logged-in operator. Also raw filename interpolated into the header. Fix: whitelist inline to jpeg/png/gif/webp, force `attachment` + `nosniff` otherwise, encode filenames. Related: `thread-view.tsx:1608` renders customer HTML in an iframe with `allow-scripts allow-same-origin` + regex sanitization only.
5. **Self-service link endpoint: rate limit keyed on client-controlled XFF + order-number 404 oracle** (`src/app/api/self-service/request-link/route.ts:31-35,78-87`). First-hop `x-forwarded-for` is client-injectable, so the IP limit is bypassable, making valid-order-number enumeration and magic-link spam unbounded. Fix: use Railway's trusted client IP / last hop; add a global cap on link sends.
6. Smaller: Meta/Printify webhooks silently skip signature verification when the secret env is unset (`social/webhook/route.ts:70`, `webhooks/printify/route.ts:16`) - refuse or log loudly in prod. `knowledge/sync` token compare not timing-safe. Email-sync RUNNING guard is check-then-create (TOCTOU) - web `/api/sync` + worker tick can collide and mark spurious FAILED syncs. Eval weekly gate fails open when Redis is down (only safe because `EVAL_WEEKLY` defaults off). Worker SIGTERM doesn't drain in-flight jobs (recovery paths exist; costs delay only). Multiple active self-service tokens per order allow confusing double-refund attempts (Shopify blocks the money).

## B. Speed - why it feels slow, cheapest wins first

1. **Threads list ships full message bodies** (`src/app/api/threads/route.ts:121-183`): mapper computes `preview` but spreads `...t` so full `bodyText` (long quoted chains) of every thread's latest message stays in the JSON. Client truncates to 60 chars. Re-downloaded every 30s (refetchInterval) and on every search keystroke. Fix is ~one line (`messages: undefined`); shrinks the hottest payload 10-20x.
2. **Every keystroke re-renders the whole 2,140-line ThreadView.** TipTap `onChange` -> `setReplyHtml` in the top component; zero memo/useMemo in thread-view.tsx or inbox-list.tsx; per-keystroke `splitReply()` regex + iframe srcDoc rebuilds. Fix: memoize the messages area; keep composer state in a memoized child/ref.
3. **Search fetches per keystroke, no debounce** (inbox-list.tsx:85,115,126; social comment-list.tsx:146-159). Debounce ~300ms + `keepPreviousData`.
4. **Thread context route: 5 sequential awaits + N+1 trackingCache + cache upserts block the response** (`src/app/api/threads/[id]/context/route.ts`). Promise.all the lookups, batch trackingCache with one findMany, fire-and-forget the upserts. Also fold the 2 stragglers in nav/counts into its Promise.all.
5. **Thread detail `staleTime: 0` + `refetchOnMount: 'always'`** (thread-view.tsx:471-472) - switching back to a read thread always waits on network. 15-30s staleTime makes switching instant. Priority sort loads 300 fat rows then slices 20 (mitigated by #1).
6. **TipTap eagerly bundled into /inbox** (no `next/dynamic` anywhere). Dynamic-import RichTextEditor, especially in compose-modal.
7. Manual sync / worker-down fallback runs full IMAP sync inside a web request (api/sync/route.ts:56) - enqueue to the worker instead. (Note: BullMQ is a declared dep but never imported; workers are plain setInterval loops.)

## C. UX / operator flow

1. **Typed replies are destroyed by clicking another thread** (thread-view.tsx:421-436 unconditionally clears composer; AI draft persists, edits don't). Per-thread draft map + confirm-before-discard. Same issue in compose-modal (close = lose everything).
2. **Inbox silently capped at 20 threads, no pagination** - badge shows true total (e.g. 34) but only 20 rows reachable. API already returns pagination; add load-more/infinite scroll. Deep links from needs-attention land in the unfiltered inbox (compounds this).
3. **Send & Close blocks on SMTP before advancing.** The social side already solved this (optimistic advance + serialized action queue, comment-detail.tsx:131-136) - port to email. Biggest per-email time saver.
4. **Attention is fragmented across 5 pages** (inbox, needs-attention, late-orders, reviews-attention, social) with a name collision (nav "Needs attention" vs reviews' internal "Needs attention" tab). Late-deliveries nav badge reads only the Redis cache and shows 0 when cold ("no late orders" lie: api/nav/counts/route.ts:87-97). Mutations don't invalidate nav-counts (stale up to 60s). Consider one "Today" overview + merge late-orders/escalations (they re-derive the same Printify handled-signals).
5. **"Email about delay" exists twice with contradictory contracts**: late-orders drafts for review, needs-attention sends hardcoded copy instantly on click with no preview (needs-attention/page.tsx:147-187). Never one-click-send customer email without preview.
6. **Keyboard + bulk**: only shortcut in the app is Cmd+Enter. Add j/k, close/trash/snooze keys, and multi-select bulk trash in inbox (api/threads/bulk exists). Snooze has no wake time. No undo-send grace. No global cross-silo search.

## D. Overlap / consolidation (ranked)

1. **Route all 3 AI draft paths through ClaudeService (M).** Social suggest and review-drafts new up their own Anthropic clients; review-drafts skips `normalizeModel()` - the exact retired-model 404 failure that bit the design pipeline is latent there. Also skips verifyDraft/sanitizer. One `buildSystemPrompt(channel)`.
2. **Delete assignment rules + multi-user scaffolding (S/M).** Rules engine + ~414-line admin UI + assignee plumbing that nothing downstream consumes. Keep User/login (VA references in schema).
3. **Shared open-items where-clause helpers per queue (S)** consumed by both pages and nav/counts (which currently re-implements every surface's filter by hand - badge drift class of bug).
4. **Shared HTTP client + integration factory (M).** 4 copy-paste `request<T>` impls + byte-identical `createXClient()` factories; only Printify retries. Retrofit Judge.me/TrackingMore first.
5. **Dead-code sweep (S):** api/admin/cleanup-resend ("DELETE after running once"), ~5/8 one-off scripts, legacy workers/email-sync.ts wrapper, unused MetaClient.verifyWebhookSignature, duplicated contact-form detection (sync-service vs zoho-imap-provider), twin models SyncJob/SocialSyncJob + ActionLog/SocialActionLog (merge when next touched).

Deliberately NOT recommended: unified queue data model, single rules engine, merging the 4 Printify-issue tables - L-effort enterprise moves a solo operator won't feel. The M win there is extracting shared "already handled" detection into lib/printify/handled-signals.ts used by both late-orders and escalations routes.

## E. Hygiene

- Lint: 51 errors / 80 warnings (mostly unused vars; 3 auto-fixable errors).
- npm audit: 11 vulns (1 low, 5 moderate, 5 high), mostly next-auth transitive uuid.
- Deps behind: Prisma 5 -> 7, @anthropic-ai/sdk 0.73 -> 0.109, nodemailer 7 -> 9, TS 5.9 -> 6. Not urgent.
- P1: tracking refresh loads 300 full order JSON blobs hourly to filter by email in JS - add a metadataEmail column when convenient.
