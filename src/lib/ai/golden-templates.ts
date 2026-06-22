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
    // Size exchange where the customer has NOT named the new size(s) yet:
    // offer the free replacement and ASK which sizes before setting it up.
    intent: 'SIZE_EXCHANGE',
    customer: "The shirts I got are too small - the sizing didn't work out as expected.",
    reply: [
      "I'm so sorry the sizing didn't work out as expected!",
      '',
      "I'd love to send you replacements in larger sizes right away - would that work for you? Just let me know what sizes would be better and I'll get new shirts into production today.",
      '',
      'You can keep or donate the current ones since shipping them back and forth just creates unnecessary waste and carbon emissions.',
    ].join('\n'),
  },
  {
    // Size exchange where the customer wants to size DOWN. Our tees run small,
    // so give the honest heads-up before creating it, and confirm the direction
    // before setting anything up.
    intent: 'SIZE_EXCHANGE',
    customer: 'Could I exchange these for a Small? The Medium is a little loose.',
    reply: [
      "Yes, we can absolutely exchange them for Small! Just a heads up though - our Small tends to run smaller than other brands, so if the Medium is only a bit loose, you might want to stick with Medium. But if you'd prefer the Small, I'm happy to create that free replacement for you.",
      '',
      "Just let me know which way you'd like to go and I'll get the new shirts into production today!",
    ].join('\n'),
  },
  {
    // PRE-PRODUCTION change: the order had NOT gone to print, so we change the
    // ORIGINAL order itself - the size, the color, or which design/variant -
    // at no cost. This is a CHANGE, not a separate replacement, so do NOT
    // mention keep/donate or sending anything back. State exactly what it was
    // changed to (e.g. "the Navy Men's Large [design]"). Only use when the
    // change was actually made in time. If the order has other items, you can
    // add that everything will still arrive together.
    intent: 'SIZE_EXCHANGE',
    customer: 'Can you change the size on my Long Sleeve to XL before it prints?',
    reply: [
      "Absolutely! I just changed your order to [the new size/color/variant] at no additional cost - I caught it just in time before it went to print, so you're all set!",
    ].join('\n'),
  },
  {
    // Size exchange where the FACTS show the customer ALSO placed a SEPARATE
    // order for the same item in the size they want (likely double purchase).
    // Confirm the free replacement, then flag the duplicate and offer to refund
    // the original so they don't pay twice. ONLY include the duplicate-flag
    // paragraph when the context actually shows that second order - never invent
    // one.
    intent: 'SIZE_EXCHANGE',
    customer: 'I need to exchange my American Bison Premium for a Large, the Medium is too small.',
    reply: [
      "I've got you covered! I can set up a free replacement in [new size] for your [item]. You can keep or donate the [old size] since having you ship it back would just create unnecessary waste and carbon emissions.",
      '',
      'I did want to flag one thing: it looks like you also placed order #[other order number] for the same [item] in [new size]. If that one was meant to be your size exchange, just let me know and I can refund the [old size] order so you are not paying twice for the same shirt.',
      '',
      "You'll get tracking info as soon as your replacement ships!",
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
    // Quality gripe with a SPECIFIC, addressable point (e.g. the tag is hard
    // to remove / scratchy). Resolve it with a brief factual explanation and
    // by forwarding the feedback to production - NOT an automatic refund.
    // Adapt the middle sentence to whatever they actually raised.
    intent: 'ORDER_ISSUE',
    customer:
      "I'm a little disappointed in the quality - the tag is really hard to get off and it is irritating.",
    reply: [
      "I'm so sorry the shirt didn't meet your expectations - that's definitely not the experience we want you to have. The tag is a tear-away style that removes very easily by gently pulling at the corner.",
      '',
      "I really appreciate you giving us the feedback about the quality - I'm forwarding this directly to our production team so we can address this issue.",
    ].join('\n'),
  },
  {
    // Quality genuinely bad (not a minor gripe) - resolve with a FULL REFUND,
    // keep/donate, and escalate to production. Say "a full refund" only; never
    // invent the dollar amount (state it only if the facts confirm it).
    intent: 'ORDER_ISSUE',
    customer: "I'm really disappointed in the quality of the shirt - it's not what I expected at all.",
    reply: [
      "I'm so sorry the shirt quality wasn't what you expected - that's really disappointing, and not at all what we want for you.",
      '',
      "I've already processed a full refund for your order, which should appear back on your card within 2-5 business days. You can keep or donate the shirt since shipping it back isn't great for the environment.",
      '',
      "I'm also escalating this to our production team so we can look into what went wrong - I really appreciate you taking the time to let us know.",
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
    // Confirmed lost (carrier confirmed / customer looked and it's still gone).
    // Offer a free replacement OR a refund and let them pick.
    intent: 'SHIPPING_STATUS',
    customer: "I still don't have my package and it's been a while - it seems lost.",
    reply: [
      'I am so sorry about this. I checked with the carrier, and the package does appear to be lost, so I want to make this right for you.',
      '',
      'Would you prefer a free replacement, or a refund instead? Just let me know which you would like and I will take care of it right away.',
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
  {
    // Pre-sale: does it shrink? Reassure (pre-shrunk) + give the care steps.
    intent: 'PRODUCT_QUESTION',
    customer: 'Do your shirts shrink after washing?',
    reply: [
      'Great question! Our tees are pre-shrunk and made from high-quality materials, so they should have minimal shrinkage if you follow the care instructions (machine wash cold, tumble dry low).',
      '',
      'That said, any cotton blend can have some slight shrinkage with hot water or high heat drying, so I always recommend washing in cold water and either air drying or using low heat in the dryer to keep them looking their best!',
    ].join('\n'),
  },
  {
    // Pre-sale shrinkage, PREMIUM vintage tee specifically.
    intent: 'PRODUCT_QUESTION',
    customer: "I'm looking at the premium vintage tee - does it shrink much in the wash?",
    reply: [
      'Great question! Our premium t-shirts are pre-shrunk and made from high-quality materials, so you can expect minimal shrinkage - typically less than 2-3% even after multiple washes.',
      '',
      "To keep it looking its best, I'd recommend washing in cold water and either air drying or using low heat in the dryer. The pre-shrinking process means it should maintain its size and fit really well over time.",
    ].join('\n'),
  },
  {
    // Pre-sale: shipping cost + customs/duties worry. NOTE the $4.87 single-tee
    // price - keep current; free shipping still kicks in at 3+ items.
    intent: 'PRODUCT_QUESTION',
    customer: 'How much is shipping for one shirt, and will I get hit with any customs or duties?',
    reply: [
      'Great question! For a single t-shirt, shipping is $4.87 within the US.',
      '',
      "All our items are printed and shipped from within the United States, so you won't have any surprise duties, customs fees, or international charges from any carrier. Everything stays domestic.",
      '',
      'We typically ship with USPS, DHL, or UPS depending on your location, and since it is all US-based, what you see at checkout is exactly what you pay - no hidden fees later.',
    ].join('\n'),
  },
  {
    // Pre-sale: where are the shirts made + how does tree planting work.
    intent: 'PRODUCT_QUESTION',
    customer: 'Where are your shirts made, and how does the tree planting work?',
    reply: [
      'Great questions! Our shirts are printed on blanks, which are manufactured in Nicaragua, Honduras, and Haiti. We then print our designs here in the US.',
      '',
      'For tree planting, we partner with One Tree Planted to plant trees in areas that need reforestation most. They work on projects all over the world - from wildfire recovery in California to rainforest restoration in the Amazon.',
    ].join('\n'),
  },
  {
    // STALLED tracking: no carrier scans for several days (not delivered, not
    // confirmed lost). After a few days of no movement, proactively send a free
    // replacement, keep-both, tracking when it ships. Carrier name genericized.
    intent: 'SHIPPING_STATUS',
    customer: "My tracking hasn't updated in several days and I still don't have my order - what's going on?",
    reply: [
      "I'm so sorry for the delay. The carrier sometimes doesn't scan packages right away so tracking can lag, but since it's been a few days with no updates, I'm going to send out a replacement for you. It's going into production today.",
      '',
      'If both orders end up arriving, you can keep both shirts - no need to return anything, since shipping items back isn\'t great for the environment.',
      '',
      "I'll send you the new tracking link as soon as it ships!",
    ].join('\n'),
  },
  {
    // RETURNED / undeliverable: tracking shows the package was forwarded and
    // returned (address issue / recipient moved). Offer a replacement but ask
    // them to CONFIRM the shipping address first so the resend doesn't bounce
    // again. Adapt the address to the one on file.
    intent: 'SHIPPING_STATUS',
    customer: "My order still hasn't arrived - can you find out what happened to it?",
    reply: [
      "I'm so sorry the shirt never arrived! I can see your order shipped, but the tracking shows it was forwarded and then returned to us - this usually happens when there's an address issue or the recipient has moved.",
      '',
      'I can send a replacement, but before I do, could you double-check the shipping address we have on file ([shipping address]) to make sure it is still correct? I want to make sure this one gets delivered successfully.',
      '',
      "I'll send you the new tracking info as soon as the replacement ships. Thanks for your patience - we'll get that shirt delivered!",
    ].join('\n'),
  },
  {
    // Address change CONFIRMED (caught before production). State the new
    // recipient + full address back to them, then tracking-when-it-ships. Only
    // use this wording when the change was actually made (facts/recent action);
    // if it is too late (in production/shipped), use the too-late handling.
    intent: 'ADDRESS_UPDATE',
    customer: 'Can you change the shipping address on my order? It needs to go to a different address.',
    reply: [
      "No problem at all - I've updated order #[order number] to ship to [new recipient name] at [new street, city, state, zip].",
      '',
      "You'll get tracking info as soon as it's on its way!",
    ].join('\n'),
  },
  {
    // Cancellation CONFIRMED (caught before production). Confirm the cancel +
    // refund in one short line. Only use when it was actually cancelled; if the
    // order is already in production/shipped, use the too-late handling instead.
    intent: 'CANCELLATION',
    customer: "Can you cancel my order? I'd like to cancel it and get a refund.",
    reply: [
      "I've got you covered! I just canceled order #[order number] and processed your refund - you should see that back on your card within a few business days.",
    ].join('\n'),
  },
  {
    // New design / product SUGGESTION (a style or subject we don't carry, e.g.
    // a v-neck). Thank them, say we'll pass it to the team, and give THANKS20.
    // Adapt to whatever they suggested. Do NOT promise the product will be made
    // or give a timeframe. (Triages as PRODUCT_QUESTION / availability.)
    intent: 'PRODUCT_QUESTION',
    customer: 'You should really make v-necks! Do you offer them?',
    reply: [
      "Great suggestion! We don't currently offer v-necks, but you're absolutely right that they'd be popular. I really appreciate feedback like this - we're always expanding our product line based on what customers ask for.",
      '',
      "I'll make sure our team knows there's interest in v-neck styles. In the meantime, here's 20% off your next order with code THANKS20 as a thank you for the suggestion!",
    ].join('\n'),
  },
  {
    // DISCOUNT - a code did not apply / calculate right. Apologize and make it
    // right with THANKS20 (20% off next order). Use for genuine code trouble,
    // not as a generic apology for unrelated issues.
    intent: 'DISCOUNT',
    customer: "I tried to use a discount code at checkout but it wouldn't apply.",
    reply: [
      "I'm so sorry about that!",
      '',
      "Let me make this right for you - here's 20% off your next order as an apology for the code trouble. Just use this code at checkout: THANKS20",
      '',
      'Thanks for your support, and sorry again for the trouble!',
    ].join('\n'),
  },
  {
    // PRICE OBJECTION ("too expensive" / "why so pricey" / "any discount?").
    // Answer the price, explain the made-to-order/DTG value briefly, then offer
    // the 15% WELCOME (email signup) discount - NOT THANKS20 (Pati's call:
    // pricing uses 15% welcome). Keep the $28-32 range current. If they seem
    // to be seeing a foreign-currency price, you can note prices show in local
    // currency.
    intent: 'PRODUCT_QUESTION',
    customer: 'Your shirts seem kind of expensive - why so pricey, and is there any discount?',
    reply: [
      'Thanks for checking out our designs! Our tees run about $28-32 depending on the size, and prices show in your local currency based on where you are shopping from.',
      '',
      "We're a small made-to-order business, so the pricing reflects the quality DTG printing and the fact that every item is printed specifically for each customer - nothing is mass-produced.",
      '',
      "If you'd like to save a bit, you can get 15% off by joining our email list (you can unsubscribe anytime). I'd love to help make it a little more accessible for you!",
    ].join('\n'),
  },
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to',
  'of', 'in', 'on', 'for', 'it', 'its', 'this', 'that', 'my', 'your', 'you',
  'i', 'we', 'me', 'so', 'with', 'at', 'as', 'if', 'do', 'did', 'can', 'could',
  'would', 'should', 'have', 'has', 'had', 'just', 'they', 'them', 'our',
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

/**
 * Curated templates for an intent. When `query` (the customer's actual
 * message) is given, return only the `limit` CLOSEST templates by keyword
 * overlap so a draft sees the most relevant examples instead of every template
 * for the intent - keeps the prompt lean as the library grows. With no query,
 * returns the first `limit` in declared order.
 */
export function goldenTemplatesForIntent(
  intent: string | null | undefined,
  query?: string,
  limit = 3
): { customer: string; reply: string }[] {
  if (!intent) return [];
  const matches = GOLDEN_TEMPLATES.filter((g) => g.intent === intent);
  if (matches.length <= limit) {
    return matches.map((g) => ({ customer: g.customer, reply: g.reply }));
  }
  if (query && query.trim()) {
    const q = keywords(query);
    const scored = matches
      .map((g) => {
        const k = keywords(g.customer);
        let overlap = 0;
        for (const w of k) if (q.has(w)) overlap++;
        return { g, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap);
    return scored.slice(0, limit).map(({ g }) => ({ customer: g.customer, reply: g.reply }));
  }
  return matches.slice(0, limit).map((g) => ({ customer: g.customer, reply: g.reply }));
}
