-- One Slack alert per Printify reprint left on hold (lib/printify/reprint-watch.ts).
ALTER TYPE "IssueAlertKind" ADD VALUE IF NOT EXISTS 'REPRINT_ON_HOLD';
