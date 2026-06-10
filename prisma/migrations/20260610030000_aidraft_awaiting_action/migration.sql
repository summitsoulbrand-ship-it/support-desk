-- Draft is held until a required action (e.g. size exchange) is taken
ALTER TYPE "AiDraftStatus" ADD VALUE IF NOT EXISTS 'AWAITING_ACTION';
