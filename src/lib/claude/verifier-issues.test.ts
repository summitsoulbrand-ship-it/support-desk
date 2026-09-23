import { describe, it, expect, vi, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeService, verifierIssues, VERIFIER_DID_NOT_RUN } from './service';
import type { SuggestionContext } from './types';

describe('verifierIssues', () => {
  it('drops a bare "may not answer" with no reason (129 of those in 30 days said nothing)', () => {
    expect(verifierIssues({ answers_question: false, why_not: '' })).toEqual({ ok: true, issues: [] });
  });

  it('keeps it when the checker says what was missed', () => {
    const r = verifierIssues({ answers_question: false, why_not: 'she asked about the XL, not the M' });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(['Verifier: may not answer their question - she asked about the XL, not the M']);
  });

  it('passes the concrete findings through', () => {
    const r = verifierIssues({
      answers_question: true,
      why_not: '',
      correct_order: false,
      unsupported_claims: ['delivered on Friday', '  '],
      missed_points: ['the second shirt'],
    });
    expect(r.issues).toEqual([
      'Verifier: the draft may reference the wrong order.',
      'Verifier: unsupported claim - delivered on Friday',
      'Verifier: missed point - the second shirt',
    ]);
  });

  it('has an honest note for a check that did not run', () => {
    expect(VERIFIER_DID_NOT_RUN).toMatch(/did not run/);
  });
});

// Vonda (#33685, 2026-09-23): the checker was asked for free-text JSON, and its
// list of claims broke on quotes ("Expected ',' or ']' after array element"),
// so the draft that invented "I have stopped that replacement" got no flag.
describe('verifyDraft', () => {
  const context: SuggestionContext = {
    messages: [
      {
        from: 'Vonda',
        date: '2026-09-22T23:53:58.000Z',
        subject: 'Re: 33685',
        body: "I don't want another 3X shirt with the same statement.",
      },
    ],
  };
  const draft = 'Hi Vonda,\n\nI have stopped that Mustard 3XL replacement.\n\nWarmly,\nThe Summit Soul Team';

  const verdict = (input: Record<string, unknown>) =>
    ({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_draft_check', input }],
      stop_reason: 'tool_use',
    }) as unknown as Anthropic.Message;

  /** The service with its API call replaced; returns the spy to read the request. */
  const serviceReturning = (reply: () => Promise<Anthropic.Message>) => {
    const service = new ClaudeService({ apiKey: 'test' });
    const create = vi.fn((params: Anthropic.MessageCreateParamsNonStreaming) => {
      void params;
      return reply();
    });
    (service as unknown as { client: { messages: { create: unknown } } }).client.messages.create = create;
    return { service, create };
  };

  afterEach(() => vi.restoreAllMocks());

  it('asks through a forced, strict tool call and keeps the rules block cached', async () => {
    const { service, create } = serviceReturning(async () =>
      verdict({ answers_question: true, why_not: '', correct_order: null, unsupported_claims: [], missed_points: [] })
    );
    expect(await service.verifyDraft(context, draft)).toEqual({ ok: true, issues: [] });

    const params = create.mock.calls[0][0];
    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: 'record_draft_check',
      disable_parallel_tool_use: true,
    });
    const tool = params.tools?.[0] as Anthropic.Tool;
    expect(tool.strict).toBe(true);
    // strict needs every field required and no extra fields allowed
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect([...(tool.input_schema.required ?? [])].sort()).toEqual(
      Object.keys(tool.input_schema.properties as object).sort()
    );
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0].text).not.toMatch(/JSON/);
  });

  it('shows a claim with quotes in it word for word', async () => {
    const claim = 'Says "I have stopped that Mustard 3XL replacement" - nothing in the facts shows it was stopped';
    const { service } = serviceReturning(async () =>
      verdict({
        answers_question: false,
        why_not: 'she said she does not want another 3X shirt',
        correct_order: true,
        unsupported_claims: [claim],
        missed_points: [],
      })
    );
    expect(await service.verifyDraft(context, draft)).toEqual({
      ok: false,
      issues: [
        'Verifier: may not answer their question - she said she does not want another 3X shirt',
        `Verifier: unsupported claim - ${claim}`,
      ],
    });
  });

  it('says it did not run, and logs it, when the verdict is cut off or never comes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cutOff = {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_draft_check', input: { answers_question: true } }],
      stop_reason: 'max_tokens',
    } as unknown as Anthropic.Message;
    const textOnly = {
      content: [{ type: 'text', text: '{"answers_question": true, "unsupported_claims": ["said "stopped""]}' }],
      stop_reason: 'end_turn',
    } as unknown as Anthropic.Message;

    for (const reply of [cutOff, textOnly]) {
      const { service } = serviceReturning(async () => reply);
      expect(await service.verifyDraft(context, draft)).toEqual({ ok: false, issues: [VERIFIER_DID_NOT_RUN] });
    }
    const { service } = serviceReturning(async () => {
      throw new Error('overloaded');
    });
    expect(await service.verifyDraft(context, draft)).toEqual({ ok: false, issues: [VERIFIER_DID_NOT_RUN] });

    expect(log).toHaveBeenCalledTimes(3);
    for (const call of log.mock.calls) expect(String(call[0])).toMatch(/^Draft verification failed/);
  });
});
