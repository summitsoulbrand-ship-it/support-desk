import { describe, it, expect } from 'vitest';
import { channelLines } from './channels';

const social = (o: Partial<Parameters<typeof channelLines>[0] & object> = {}) => ({
  comments: 25,
  complaints: 0,
  questions: 0,
  unreviewed: 0,
  average: 24,
  ...o,
});

const reviews = (o = {}) => ({ total: 6, lowStar: 0, avgRating: 4.8, capped: false, ...o });

describe('channelLines', () => {
  it('gives the comment count against what a normal day looks like', () => {
    const [line] = channelLines(social(), reviews());
    expect(line).toBe('Social comments: 25 (normally 24/day)');
  });

  it('pulls out the comments that are worth acting on', () => {
    const [line] = channelLines(
      social({ comments: 29, complaints: 2, questions: 5, unreviewed: 4 }),
      reviews()
    );
    expect(line).toContain('2 complaints');
    expect(line).toContain('5 questions');
    expect(line).toContain('4 not looked at this week');
  });

  it('says a source could not be read rather than calling it zero', () => {
    // The failure this whole report was built to replace: a job that stopped
    // and a genuinely quiet day look identical as a number.
    expect(channelLines(null, null)).toEqual([
      'Social comments: could not read them today',
      'Reviews: could not read them today',
    ]);
  });

  it('still says zero when zero is really zero', () => {
    expect(channelLines(social(), reviews({ total: 0 }))[1]).toBe('Reviews: none today');
  });

  it('calls out low-star reviews, because those are the ones to go and read', () => {
    const [, line] = channelLines(social(), reviews({ total: 8, lowStar: 2, avgRating: 4.1 }));
    expect(line).toBe('Reviews: 8, 4.1 stars average - 2 reviews at 3 stars or below');
  });

  it('marks a capped count as a floor rather than reporting a page limit', () => {
    const [, line] = channelLines(social(), reviews({ total: 200, capped: true }));
    expect(line).toContain('200+');
  });

  it('counts one of a thing without an s on it', () => {
    const [social_, review_] = channelLines(
      social({ complaints: 1, questions: 1 }),
      reviews({ total: 3, lowStar: 1 })
    );
    expect(social_).toContain('1 complaint,');
    expect(social_).toContain('1 question');
    expect(social_).not.toContain('1 complaints');
    expect(review_).toContain('1 review at');
  });

  it('always returns one line per channel', () => {
    expect(channelLines(social(), reviews())).toHaveLength(2);
    expect(channelLines(null, reviews())).toHaveLength(2);
    expect(channelLines(social(), null)).toHaveLength(2);
  });
});
