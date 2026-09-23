/**
 * Hand-picked GOLD-STANDARD reply templates. These are baked in so they DON'T
 * depend on old threads still being in the database - they are always available
 * as few-shot examples for the matching intent, and the AI mirrors their slim
 * style.
 *
 * VOICE (refreshed 2026-07-14 for the 45-75 audience): plain, warm, unhurried.
 * Short sentences. No hype, no peppy openers ("Great question!"), no stacked
 * exclamation points, no "I've got you covered". The serious templates (lost
 * package, defect, refund) were already on-voice and are kept as-is.
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
  /**
   * Only shown when triage flagged a genuinely NEW design idea. The morel
   * example carries THANKS20, and the keyword picker made it the first choice
   * for catalog questions like "do you make the frog wizard in a hoodie?" -
   * exactly the requests the rules say get no code.
   */
  designIdeaOnly?: boolean;
}

export const GOLDEN_TEMPLATES: GoldenTemplate[] = [
  {
    intent: 'SIZE_EXCHANGE',
    customer:
      'Hi, I just got my order but the shirts are too small. Could I exchange all three for size Large?',
    reply: [
      "Happy to help. I've set up a free replacement for all three shirts in Large, and it's going into production today. You can keep or donate the original shirts, since shipping them back would just create unnecessary waste and carbon emissions.",
      '',
      "You'll get tracking as soon as your new shirts are on the way.",
    ].join('\n'),
  },
  {
    // Size exchange where the customer has NOT named the new size(s) yet:
    // offer the free replacement and ASK which sizes before setting it up.
    intent: 'SIZE_EXCHANGE',
    customer: "The shirts I got are too small - the sizing didn't work out as expected.",
    reply: [
      "I'm sorry the sizing didn't work out.",
      '',
      "I'd be glad to send free replacements in larger sizes. Just let me know which sizes would be better and I'll get new shirts into production today.",
    ].join('\n'),
  },
  {
    // Size exchange where a WOMAN wants to size DOWN. Our sizing is unisex, so
    // it wears roomy on women - sizing down is the RIGHT call for a fitted
    // look and must never be talked out of. Confirm it warmly and move on.
    intent: 'SIZE_EXCHANGE',
    customer: 'Could I exchange these for a Small? The Medium is a little loose. - Sarah',
    reply: [
      "Yes, I'd be glad to exchange them for Small. Our sizing is unisex, so it does wear a bit roomier on women, and the Small should give you the more fitted look you're after.",
      '',
      "I'll get the new shirts into production today.",
    ].join('\n'),
  },
  {
    // Size exchange where the shirts arrived too BIG on a woman. Do NOT
    // generalize about sizing beyond the unisex explanation, and never suggest
    // she size up. Ask for the exact size when she has not named one.
    intent: 'SIZE_EXCHANGE',
    customer:
      "The shirts arrived and they're HUGE. I ordered up as suggested. What can be done? - Linda",
    reply: [
      "I'm sorry these came out bigger than you were hoping.",
      '',
      "Our sizing is unisex, so it wears roomier on women - your regular size is usually the sweet spot, or one size down if you like it more fitted. Just let me know which size you'd like the free replacements in and I'll get them into production right away.",
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
      "Good news - I caught your order just in time before it went to print and changed it to [the new size/color/variant] at no additional cost. You're all set.",
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
      "Happy to help. I can set up a free replacement in [new size] for your [item]. You can keep or donate the [old size], since shipping it back would just create unnecessary waste and carbon emissions.",
      '',
      "One thing I wanted to flag: it looks like you also placed order #[other order number] for the same [item] in [new size]. If that one was meant to be your size exchange, just let me know and I can refund the [old size] order so you're not paying twice for the same shirt.",
      '',
      "You'll get tracking as soon as your replacement is on the way.",
    ].join('\n'),
  },
  {
    intent: 'SHIPPING_STATUS',
    customer: "Hi, where is my order? I still haven't received it.",
    reply: [
      'I can see your order shipped and the tracking shows it on its way. You can check the latest status here: [tracking link].',
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
      "I've already processed a full refund for your order, which should appear back on your card within 3-5 business days. You can keep or donate the shirt, since shipping it back would just create unnecessary waste and carbon emissions.",
      '',
      "I'm also escalating this to our production team so we can look into what went wrong - I really appreciate you taking the time to let us know.",
    ].join('\n'),
  },
  {
    // Customer ordered the WRONG design (their mistake): they say it's the wrong
    // shirt, but the order shows they received exactly what they ordered. Still
    // make it right with a FREE replacement of the design they wanted, while
    // gently making clear it was not our error. See TOP RULE 9. Adapt the
    // ordered item and the wanted item/color/size to THIS order's facts.
    intent: 'ORDER_ISSUE',
    customer: "These aren't the shirts I wanted - I got the wrong design.",
    reply: [
      "I'm so sorry about the mix-up. According to our system, it seems you ordered the [design they actually ordered] shirts.",
      '',
      "But I understand mistakes happen, and I want to make it right. I've set up a free replacement with the [design / color / size they wanted], and it's going into production today.",
      '',
      'You can keep or donate the [design they ordered] tees, since shipping them back would just create unnecessary waste and carbon emissions. You will get tracking as soon as your replacement is on the way.',
    ].join('\n'),
  },
  {
    intent: 'RETURN_REFUND',
    customer: "I didn't authorize this order / there's been a mix-up. I'd like a refund.",
    reply: [
      "I completely understand, and I'll get this sorted for you right away.",
      '',
      "I'm processing a full refund for your order now - you should see the credit back on your card within 3-5 business days. I've also canceled the order so nothing will ship out.",
    ].join('\n'),
  },
  {
    // Delivered-but-not-received, FIRST reply. Rewritten 2026-09-07 from the
    // replies Pati actually sent: apology, the carrier's record, the ship-to
    // address, and one closing question. She deleted the early-scan
    // explanation and the check-around-the-property advice from 9 of the 12
    // drafts that carried them, so neither belongs here any more.
    intent: 'SHIPPING_STATUS',
    customer: 'My tracking says delivered but I never got my package.',
    reply: [
      'I am sorry your package has not turned up. Our records show it was marked delivered by [carrier] on [day, date] at [time] in [city, state]. You can see the tracking here: [tracking link]',
      '',
      'Our records show the order shipped to [shipping address on the order].',
      '',
      'Do we have the correct address?',
    ].join('\n'),
  },
  {
    // Lost (address confirmed, or it has clearly gone missing in transit): send
    // a free replacement - no replacement-or-refund menu. Pati switched this to
    // the operator's way on 2026-09-22: she removed the choice 18 of 22 times.
    // A customer who asks for a refund still gets one (TOP RULE 5).
    intent: 'SHIPPING_STATUS',
    customer: "I still don't have my package and it's been a while - it seems lost.",
    reply: [
      'I am so sorry about this. It looks like your package was lost in transit, so we will send you a free replacement right away.',
      '',
      'You will get tracking as soon as it is on the way.',
    ].join('\n'),
  },
  {
    // Stuck order: 6+ days old and tracking shows only a created label with NO
    // carrier scan. Apologize and send a free replacement - no menu (Pati
    // 2026-09-22). Under 6 days, just reassure (see the delay steps in
    // STORE_POLICY_FACTS).
    intent: 'SHIPPING_STATUS',
    customer:
      'Hi, has my order shipped yet? I placed it almost a week ago and I have not gotten any tracking updates.',
    reply: [
      'I am sorry for the delay. A shipping label was created for your order, but the carrier has not picked it up and scanned it yet, and there should have been movement by now.',
      '',
      'So we will send you a free replacement right away. You will get tracking as soon as it is on the way.',
    ].join('\n'),
  },
  {
    // Slightly delayed: customer asks for a shipping update and the order has
    // NOT shipped after ~4-5 days (still in production). Apologize for the slight
    // delay and give the estimated window from the context (never invent dates).
    // See TOP RULE 8. At 6+ days with no movement, use the stuck-order template.
    intent: 'SHIPPING_STATUS',
    customer: 'Can you give me an update on my order? I ordered a few days ago and have not seen it ship.',
    reply: [
      'Your order is currently in production. There is a slight delay on our end, but it should ship any moment now - our made-to-order timeline is up to 4 business days in production, then 2 to 5 business days shipping.',
      '',
      'You will get an email with tracking as soon as it ships.',
    ].join('\n'),
  },
  {
    // Pure thank-you / praise. Keep it short and genuine - never tack on an
    // offer or a sales line, and do NOT open with "This made my day" (banned).
    intent: 'POSITIVE_FEEDBACK',
    customer: 'I just wanted to say I love my shirt - thank you so much!',
    reply: [
      'Thank you so much, this really means a lot.',
      '',
      'I appreciate you taking the time to tell me. Messages like yours are a big part of why we do this.',
    ].join('\n'),
  },
  {
    // Pre-sale sizing, WOMAN asking for herself. Unisex sizing wears roomy on
    // women, so the answer is her regular size (or one down for fitted).
    // NEVER tell a woman to size up.
    intent: 'PRODUCT_QUESTION',
    customer: "I'm usually a women's medium - what size should I order? - Karen",
    reply: [
      'Our sizing is unisex, so it wears a little roomier on women. A Medium should be great for you, and if you like a more fitted look, going down to a Small is a safe call.',
      '',
      "There's a full size chart with exact measurements on the product page if you'd like to compare against a shirt you already love.",
    ].join('\n'),
  },
  {
    // Pre-sale sizing, MAN asking for himself. Unisex sizing is cut to a men's
    // spec and runs small on a man's frame, so he sizes UP.
    intent: 'PRODUCT_QUESTION',
    customer: "I normally wear a large. Should I order a large or an XL? - Dave",
    reply: [
      'Our sizing is unisex and runs a little small on men, so I would go with the XL. That will give you the comfortable classic fit most guys are after.',
      '',
      "There's a full size chart with exact measurements on the product page if you'd like to compare against a shirt you already wear.",
    ].join('\n'),
  },
  {
    // Pre-sale sizing where the WEARER is a man even though a woman is writing.
    // Always answer for the wearer, not the writer.
    intent: 'PRODUCT_QUESTION',
    customer: "I'm buying this for my husband, he wears an XL. What should I get? - Marie",
    reply: [
      'Our sizing is unisex and runs a little small on men, so I would order the 2XL for him. That will give him the comfortable classic fit rather than a snug one.',
      '',
      "There's a full size chart with exact measurements on the product page if you'd like to compare against a shirt he already wears.",
    ].join('\n'),
  },
  {
    // Pre-sale: does it shrink? Reassure (pre-shrunk) + give the care steps.
    intent: 'PRODUCT_QUESTION',
    customer: 'Do your shirts shrink after washing?',
    reply: [
      'Our tees are pre-shrunk and made from high-quality materials, so they should have minimal shrinkage if you follow the care instructions (machine wash cold, tumble dry low).',
      '',
      "That said, any cotton blend can shrink a little with hot water or high heat, so I'd recommend washing in cold water and either air drying or using low heat in the dryer to keep them looking their best.",
    ].join('\n'),
  },
  {
    // Pre-sale shrinkage, PREMIUM vintage tee specifically.
    intent: 'PRODUCT_QUESTION',
    customer: "I'm looking at the premium vintage tee - does it shrink much in the wash?",
    reply: [
      'Our premium tees are pre-shrunk and made from high-quality materials, so you can expect minimal shrinkage, typically less than 2-3% even after multiple washes.',
      '',
      "To keep it looking its best, I'd recommend washing in cold water and either air drying or using low heat in the dryer. The pre-shrinking means it should hold its size and fit well over time.",
    ].join('\n'),
  },
  {
    // Pre-sale: shipping cost + customs/duties worry, for a US customer. NOTE
    // the $4.87 single-tee price - keep current; free shipping at 3+ items.
    // International shipping and duties are NOT covered by this example.
    intent: 'PRODUCT_QUESTION',
    customer: 'How much is shipping for one shirt, and will I get hit with any customs or duties?',
    reply: [
      'For a single t-shirt shipped within the US, shipping is $4.87, and orders of 3 or more items ship free.',
      '',
      "For a US address there are no duties or customs fees - what you see at checkout is what you pay.",
    ].join('\n'),
  },
  {
    // Pre-sale: where are the shirts made + how does tree planting work.
    // Tree facts must match STORE_POLICY_FACTS: verified reforestation partners
    // (GoodAPI network), mostly mangroves in Kenya and Madagascar. Do NOT name
    // "One Tree Planted" or invent Amazon/California projects.
    intent: 'PRODUCT_QUESTION',
    customer: 'Where are your shirts made, and how does the tree planting work?',
    reply: [
      'Our shirts are printed on blanks that are most often made in Honduras or Nicaragua, and we print our designs here in the US.',
      '',
      "For the tree planting, we work with verified reforestation partners to plant a tree for every purchase, mostly mangroves along the coasts of Kenya and Madagascar. They're great at storing carbon and protecting the coastline.",
    ].join('\n'),
  },
  {
    // STALLED in transit: shipped, but no carrier update for a long time (about
    // 15+ days since the order). Send a free replacement - no menu (Pati
    // 2026-09-22). A recent order with a quiet tracking page just gets the
    // "tracking can lag a day or two" line instead. Carrier genericized.
    intent: 'SHIPPING_STATUS',
    customer: "My tracking hasn't updated in ages and I still don't have my order - what's going on?",
    reply: [
      "I'm so sorry for the wait. Your order shipped, but the carrier has not updated the tracking in a long time, so it looks like it was lost in transit.",
      '',
      "We will send you a free replacement right away, and you'll get tracking as soon as it's on the way.",
    ].join('\n'),
  },
  {
    // RETURNED / undeliverable: tracking shows the package was forwarded and
    // returned (address issue / recipient moved). Ask them to CONFIRM the
    // shipping address first - one question, nothing else - so the resend does
    // not bounce again; once they confirm, the free replacement follows.
    // Adapt the address to the one on file.
    intent: 'SHIPPING_STATUS',
    customer: "My order still hasn't arrived - can you find out what happened to it?",
    reply: [
      "I'm sorry the shirt never arrived. I can see your order shipped, but the tracking shows it was forwarded and then returned to us, which usually happens when there's an address issue or the recipient has moved.",
      '',
      "Can you please confirm we have the correct address? [shipping address]",
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
      "Done - I've updated order #[order number] to ship to [new recipient name] at [new street, city, state, zip].",
      '',
      "You'll get tracking as soon as it's on the way.",
    ].join('\n'),
  },
  {
    // Cancellation CONFIRMED (caught before production). Confirm the cancel +
    // refund in one short line. Only use when it was actually canceled; if the
    // order is already in production/shipped, use the too-late handling instead.
    intent: 'CANCELLATION',
    customer: "Can you cancel my order? I'd like to cancel it and get a refund.",
    reply: [
      "Done - I've canceled order #[order number] and processed your refund. You should see it back on your card within a few business days.",
    ].join('\n'),
  },
  {
    // New design SUGGESTION - a genuinely new design IDEA (a specific subject,
    // joke, or concept we could print). This is the case that earns THANKS20.
    // Do NOT attach a discount to generic style/product-type requests (more
    // colors, a lighter fabric, a v-neck) - for those, warm thanks is the whole
    // reply, no code. Do NOT promise the design will be made or give a timeframe.
    intent: 'PRODUCT_QUESTION',
    designIdeaOnly: true,
    customer: 'You should make a design about morel mushroom hunting, something like "Trust Me, I Know a Spot".',
    reply: [
      "Thanks for the idea. A morel hunting design with a line like that is exactly the kind of thing we love to explore, and I'll pass it along to our team.",
      '',
      "I can't promise if or when it'll happen, but I really appreciate you sharing it. As a thank you, here's 20% off your next order with code THANKS20.",
    ].join('\n'),
  },
  {
    // DISCOUNT - a code did not apply / calculate right. Apologize and make it
    // right with THANKS20 (20% off next order). Use for genuine code trouble,
    // not as a generic apology for unrelated issues.
    intent: 'DISCOUNT',
    customer: "I tried to use a discount code at checkout but it wouldn't apply.",
    reply: [
      "I'm sorry the code gave you trouble.",
      '',
      "Let me make it right - here's 20% off your next order with code THANKS20 at checkout.",
      '',
      'Sorry again for the hassle, and thanks for letting me know.',
    ].join('\n'),
  },
  {
    // PRICE OBJECTION ("too expensive" / "why so pricey" / "any discount?").
    // Answer the price, give the value reasons briefly, then offer the 15%
    // WELCOME (email signup) discount - NOT THANKS20 (Pati's call: pricing
    // uses 15% welcome). Starting prices checked live 2026-09-22 (classic
    // $29.95, Premium $33.95); the draft quotes from the Price by Size list.
    intent: 'PRODUCT_QUESTION',
    customer: 'Your shirts seem kind of expensive - why so pricey, and is there any discount?',
    reply: [
      'Our classic tees start at $29.95 and our Premium heavyweight tees at $33.95, and the price steps up a little with size.',
      '',
      "We're a small, US-based, owner-run business: every shirt is made to order on US-grown cotton, never mass-produced, and we plant a tree with every order.",
      '',
      "If you'd like to save a little, you can get 15% off by joining our email list (you can unsubscribe anytime).",
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
/**
 * Templates that state a refund or cancellation as ALREADY DONE. They are
 * correct replies for the moment the operator has actually refunded, but the
 * prompt tells the model to mirror these closely - so handing one to a thread
 * where nothing has been refunded teaches it to invent the refund. It did
 * exactly that on #30877: "our system automatically processed a full refund",
 * to a customer who had not been refunded at all (Pati, 2026-08-09).
 */
// "I'm processing a full refund ... I've also canceled the order" slipped
// past the first version of this (no "processing", no "also").
const CLAIMS_COMPLETED_MONEY_ACTION =
  /(already|I have|I've|we have|we've)\s+(also\s+)?(processed|issued|refunded|canceled|cancelled)|processed (your|a full) refund|processing (your|a|a full) refund|refund (has been|was) (issued|processed)/i;

export function goldenTemplatesForIntent(
  intent: string | null | undefined,
  query?: string,
  limit = 3,
  /** Set when this thread's facts prove a refund/cancel already happened. */
  moneyActionConfirmed = false,
  /** Set when triage flagged the message as a genuinely new design idea. */
  designIdea = false
): { customer: string; reply: string }[] {
  if (!intent) return [];
  const matches = GOLDEN_TEMPLATES.filter(
    (g) =>
      g.intent === intent &&
      (designIdea || !g.designIdeaOnly) &&
      (moneyActionConfirmed || !CLAIMS_COMPLETED_MONEY_ACTION.test(g.reply))
  );
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
