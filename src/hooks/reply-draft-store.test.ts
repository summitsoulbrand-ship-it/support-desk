import { describe, it, expect, beforeEach } from 'vitest';
import {
  getReplyDraft,
  setReplyDraft,
  clearReplyDraft,
  dismissAiDraft,
  isAiDraftDismissed,
  clearAiDraftDismissal,
} from '@/hooks/reply-draft-store';

const THREAD = 'thread-1';
const OTHER = 'thread-2';
const DRAFT = 'Hi Jane,\n\nYour order shipped Tuesday.\n\n- Summit Soul';

describe('reply draft store', () => {
  beforeEach(() => {
    clearReplyDraft(THREAD);
    clearReplyDraft(OTHER);
    clearAiDraftDismissal(THREAD);
    clearAiDraftDismissal(OTHER);
  });

  it('keeps hand-typed drafts per thread', () => {
    setReplyDraft(THREAD, '<p>typed</p>');
    expect(getReplyDraft(THREAD)).toBe('<p>typed</p>');
    expect(getReplyDraft(OTHER)).toBe('');
  });

  it('treats whitespace-only content as no draft', () => {
    setReplyDraft(THREAD, '   ');
    expect(getReplyDraft(THREAD)).toBe('');
  });
});

describe('AI draft dismissal', () => {
  beforeEach(() => {
    clearAiDraftDismissal(THREAD);
    clearAiDraftDismissal(OTHER);
  });

  it('is off until the composer is emptied', () => {
    expect(isAiDraftDismissed(THREAD, DRAFT)).toBe(false);
  });

  // The actual bug: emptying the composer left no record, so the auto-load
  // effect re-seeded the same draft and it looked undeletable.
  it('stops the same draft from being auto-loaded again', () => {
    dismissAiDraft(THREAD, DRAFT);
    expect(isAiDraftDismissed(THREAD, DRAFT)).toBe(true);
  });

  it('still lets a different (regenerated or refined) draft load', () => {
    dismissAiDraft(THREAD, DRAFT);
    expect(isAiDraftDismissed(THREAD, DRAFT + ' PS: tracking attached.')).toBe(
      false
    );
  });

  it('is scoped to one thread', () => {
    dismissAiDraft(THREAD, DRAFT);
    expect(isAiDraftDismissed(OTHER, DRAFT)).toBe(false);
  });

  it('is lifted once the reply is sent', () => {
    dismissAiDraft(THREAD, DRAFT);
    clearAiDraftDismissal(THREAD);
    expect(isAiDraftDismissed(THREAD, DRAFT)).toBe(false);
  });

  it('never dismisses on an empty body', () => {
    dismissAiDraft(THREAD, '');
    expect(isAiDraftDismissed(THREAD, '')).toBe(false);
  });
});
