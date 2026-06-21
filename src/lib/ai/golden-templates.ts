/**
 * Hand-picked GOLD-STANDARD reply templates (Pati's real best replies from the
 * May golden period). These are baked in so they DON'T depend on the May
 * threads still being in the database - they are always available as few-shot
 * examples for the matching intent, and the AI mirrors their slim style.
 *
 * Specifics that the AI can't know at draft time (a NEW replacement order
 * number, a tracking number, an address) are removed from the template - the
 * model fills in only what THIS thread's facts provide.
 *
 * Add more as Pati shares them: one entry per case, intent = TriageIntent.
 */

export interface GoldenTemplate {
  intent: string;
  customer: string;
  reply: string;
}

export const GOLDEN_TEMPLATES: GoldenTemplate[] = [
  {
    intent: 'SIZE_EXCHANGE',
    customer:
      'Hi, I just got my order but the shirts are too small. Could I exchange all three for size Large?',
    reply: [
      "I've got you covered! I just set up a free replacement for all three shirts in Large - it's going into production today. You can keep or donate the original shirts since having you ship them back would just create unnecessary waste and carbon emissions.",
      '',
      "You'll get tracking info as soon as your new shirts ship!",
    ].join('\n'),
  },
];

export function goldenTemplatesForIntent(
  intent: string | null | undefined
): { customer: string; reply: string }[] {
  if (!intent) return [];
  return GOLDEN_TEMPLATES.filter((g) => g.intent === intent).map((g) => ({
    customer: g.customer,
    reply: g.reply,
  }));
}
