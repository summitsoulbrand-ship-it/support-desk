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
  {
    intent: 'SHIPPING_STATUS',
    customer: "Hi, where is my order? I still haven't received it.",
    reply: [
      'I can see your order shipped and the tracking shows it on its way. You can check the latest status here: [tracking link].',
      '',
      "If it's not showing as delivered or you can't find the package, just let me know and I'll get a replacement sent out right away.",
    ].join('\n'),
  },
  {
    intent: 'ORDER_ISSUE',
    customer: 'The shirt I received has a problem - it looks defective.',
    reply: [
      "Oh no, I'm so sorry about that - that definitely shouldn't happen, and I really appreciate you letting us know.",
      '',
      "Could you send a quick photo of the issue? Once I can see it, I'll get a free replacement sent out right away (or a refund instead if you'd prefer). I'm also escalating this to our production team to look into it.",
    ].join('\n'),
  },
  {
    intent: 'RETURN_REFUND',
    customer: "I didn't authorize this order / there's been a mix-up. I'd like a refund.",
    reply: [
      "I completely understand, and I'll get this sorted for you right away.",
      '',
      "I'm processing a full refund for your order now - you should see the credit back on your card within 2-3 business days. I've also cancelled the order so nothing will ship out.",
    ].join('\n'),
  },
  {
    // Delivered-but-not-received, first reply. Acknowledge the early-scan
    // possibility, ask if it has shown up, and offer the conditional replacement.
    intent: 'SHIPPING_STATUS',
    customer: 'My tracking says delivered but I never got my package.',
    reply: [
      "Thanks for reaching out. Sometimes shipping providers mark packages as delivered a bit early, so there's a chance it might still arrive in the next day or two.",
      '',
      'Has it shown up in the meantime since you sent this message? If not, I am happy to send you a free replacement.',
    ].join('\n'),
  },
  {
    // Pure thank-you / praise. Keep it short and genuine - never tack on an
    // offer or a sales line.
    intent: 'POSITIVE_FEEDBACK',
    customer: 'I just wanted to say I love my shirt - thank you so much!',
    reply: [
      'This made my day!',
      '',
      'Thanks for taking the time to tell me about it. Messages like yours remind me why we do this.',
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
