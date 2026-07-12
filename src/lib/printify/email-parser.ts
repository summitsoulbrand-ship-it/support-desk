/**
 * Parser for Printify support emails (from merchantsupport@printify.com).
 *
 * These emails are running transcripts of the live-chat / ticket conversation,
 * emailed to summitsoulbrand@gmail.com. We mine them for two things:
 *
 *  1. RESOLUTIONS - confirmed outcomes Printify gave us on an order: a refund,
 *     a partial refund, a free reprint, or a cancellation credited to balance.
 *     This is the money-recovery signal: it tells the Late Deliveries tracker
 *     "Printify made us whole on this order" so the operator stops ticking it
 *     by hand and we can total what was recovered.
 *
 *  2. REQUESTS - orders the operator ASKED Printify to refund/reprint/cancel,
 *     where the agent said they'd "email back". Those resolutions land in a
 *     LATER email, so a request with no matching resolution = money still owed,
 *     surfaced as "awaiting Printify".
 *
 * Order IDs in these emails are always Printify's display number, e.g.
 * "19269685.18793" (shopId.orderNumber) - the same value as the Printify
 * order object's `app_order_id`, which is how we match back to our records.
 *
 * Pure string logic - no IO, fully unit-tested against real transcripts.
 */

export type PrintifyOutcomeType =
  | 'refund'
  | 'partial_refund'
  | 'reprint'
  | 'cancellation'
  // Printify explicitly said NO (not eligible / unable to refund). The evidence
  // line carries their explanation, surfaced on the Late Deliveries page.
  | 'declined';

export interface PrintifyResolution {
  /** Printify display order number, e.g. "19269685.18793" (= app_order_id). */
  appOrderId: string;
  type: PrintifyOutcomeType;
  /** USD amount for (partial) refunds. Undefined for reprints / balance credits. */
  amountUsd?: number;
  /** For reprints: the new order Printify created. */
  reprintAppOrderId?: string;
  /** The transcript line we matched, kept for audit / operator review. */
  evidence: string;
}

export type PrintifyRequestIntent = 'refund' | 'reprint' | 'cancel';

export interface PrintifyRequest {
  appOrderId: string;
  intent: PrintifyRequestIntent;
  evidence: string;
}

/**
 * Any agent line that talks ABOUT an order - refund or not (pickup waiting,
 * held at post office, forwarded, delivered-but-not-synced, ...). The raw
 * sentence is surfaced on the Late Deliveries row and prefilled into the
 * customer delay email; the operator edits before sending.
 */
export interface PrintifyAnswer {
  appOrderId: string;
  text: string;
}

export interface ParsedPrintifyEmail {
  resolutions: PrintifyResolution[];
  requests: PrintifyRequest[];
  answers: PrintifyAnswer[];
}

/** Printify shop-order display number: 6+ digit shop id, a dot, 1+ digit order. */
const ORDER_ID = /\b(\d{6,}\.\d+)\b/;
const ORDER_ID_G = /\b(\d{6,}\.\d+)\b/g;

/** A transcript chat line looks like "(06:32:42) Aisha Byrd: text...". */
const CHAT_LINE = /^\((\d{2}:\d{2}:\d{2})\)\s*([^:]+?):\s*(.*)$/;

const OPERATOR_NAMES = ['patrizia', 'pati'];

function isOperator(speaker: string | null): boolean {
  if (!speaker) return false;
  const s = speaker.toLowerCase();
  return OPERATOR_NAMES.some((n) => s.includes(n));
}

function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

interface Line {
  /** Speaker name if this is a chat line, else null (prose / system). */
  speaker: string | null;
  /** Message text (chat line) or the whole raw line (prose). */
  text: string;
  raw: string;
}

function splitLines(body: string): Line[] {
  return body
    .split(/\r?\n/)
    .map((raw) => {
      const m = raw.match(CHAT_LINE);
      if (m) return { speaker: m[2].trim(), text: m[3].trim(), raw: raw.trim() };
      return { speaker: null, text: raw.trim(), raw: raw.trim() };
    })
    .filter((l) => l.text.length > 0);
}

/**
 * Structured batch confirmations, one order per line, e.g.:
 *   19269685.12034 - reprint order 19269685.13134
 *   19269685.11859 - refunded USD 13.69
 *   19269685.12362 - partial refund USD 8.80
 */
function matchStructured(text: string): PrintifyResolution | null {
  const reprint = text.match(
    /(\d{6,}\.\d+)\s*[-–—]\s*reprint(?:ed)?(?:\s+order)?\s+(\d{6,}\.\d+)/i
  );
  if (reprint) {
    return {
      appOrderId: reprint[1],
      type: 'reprint',
      reprintAppOrderId: reprint[2],
      evidence: text,
    };
  }
  // "partial refund" must be checked before plain "refund".
  const partial = text.match(
    /(\d{6,}\.\d+)\s*[-–—]\s*partial refund\s+USD\s+([\d.,]+)/i
  );
  if (partial) {
    return {
      appOrderId: partial[1],
      type: 'partial_refund',
      amountUsd: parseAmount(partial[2]),
      evidence: text,
    };
  }
  const refund = text.match(
    /(\d{6,}\.\d+)\s*[-–—]\s*(?:full\s+)?refund(?:ed)?\s+USD\s+([\d.,]+)/i
  );
  if (refund) {
    return {
      appOrderId: refund[1],
      type: 'refund',
      amountUsd: parseAmount(refund[2]),
      evidence: text,
    };
  }
  return null;
}

/** Confirmation verbs that mean Printify actually DID the thing (past/done). */
const REFUND_DONE =
  /\b(?:has\s+been|have\s+been|now\s+been|is\s+now|already)\b[^.]*\brefund(?:ed)?\b|\brefund\b[^.]*\b(?:has|have|now)\s+been\s+(?:issued|processed)\b|\brefund(?:ed)?\s+(?:of\s+)?USD\b|\b(?:was|were)\s+refunded\b|\brefunded\s+in\s+full\b|\brefund\b[^.]*\balready\s+processed\b/i;
// "A production cost has been issued." - Printify's phrasing for a
// production-cost-only refund that never says the word "refund" (2026-07 batch
// follow-up email). Counted as a partial refund.
const PRODUCTION_COST_DONE =
  /\bproduction\s+cost\b[^.]*\b(?:has|have)\s+been\s+issued\b/i;
const CANCEL_DONE =
  /\bprocessed\s+the\s+cancellation\b|\bhas\s+been\s+cancell?ed\b|\bcancellation\s+(?:has|was)\s+(?:been\s+)?(?:processed|completed|approved)\b/i;
const AMOUNT_USD = /USD\s+([\d.,]+)/i;
// Explicit refusals: "we are unable to issue a refund since...", "the order is
// not eligible for a refund", "your refund request has been declined". The
// matched sentence usually carries Printify's reason - kept as evidence.
const REFUND_DECLINED =
  /\b(?:unable\s+to|not\s+(?:be\s+)?able\s+to|cannot|can'?t|won'?t\s+be\s+able\s+to)\b[^.]*\b(?:refund|reimburse|compensat)/i;
const REFUND_DECLINED_ALT =
  /\bnot\s+eligible\s+for\b[^.]*\brefund\b|\brefund\b[^.]*\b(?:has\s+been\s+|was\s+)?(?:declined|denied|rejected|not\s+possible)\b/i;

/**
 * Prose resolutions where the order id and the confirmation are spread across
 * the sentence or adjacent lines, e.g.:
 *   "A full refund has now been issued since it's needed for a trip - USD 67.95."
 *   "...successfully processed the cancellation of your order 19269685.20437."
 *
 * Only agent (non-operator) lines count, and only confirmation phrasing - never
 * the operator's "please refund" request.
 */
function matchProse(
  lines: Line[],
  index: number,
  seen: Set<string>,
  mode: 'confirmed' | 'declined'
): PrintifyResolution | null {
  const line = lines[index];
  if (isOperator(line.speaker)) return null;
  const text = line.text;

  const isCancel = mode === 'confirmed' && CANCEL_DONE.test(text);
  // Declines run as a SEPARATE last pass: a refusal line also contains the
  // word "refund", and an agent who first declines but later refunds (after
  // pushback) must resolve as the refund, never the decline.
  const isDeclined =
    mode === 'declined' &&
    (REFUND_DECLINED.test(text) || REFUND_DECLINED_ALT.test(text));
  const isRefund =
    mode === 'confirmed' && !isCancel && !REFUND_DECLINED.test(text) &&
    !REFUND_DECLINED_ALT.test(text) &&
    (REFUND_DONE.test(text) || PRODUCTION_COST_DONE.test(text));
  if (!isCancel && !isDeclined && !isRefund) return null;

  // Find the order id: prefer one in this same line, else the nearest order id
  // mentioned in the previous few lines (the agent referencing the order).
  let appOrderId: string | null = null;
  const inLine = text.match(ORDER_ID);
  if (inLine) {
    appOrderId = inLine[1];
  } else {
    for (let j = index - 1; j >= 0 && j >= index - 4; j--) {
      const m = lines[j].text.match(ORDER_ID);
      if (m) {
        appOrderId = m[1];
        break;
      }
    }
  }
  if (!appOrderId || seen.has(appOrderId)) return null;

  if (isCancel) {
    return { appOrderId, type: 'cancellation', evidence: text };
  }

  if (isDeclined) {
    return { appOrderId, type: 'declined', evidence: text };
  }

  const amt = text.match(AMOUNT_USD);
  // Production-cost-only confirmations (no "refund" wording) are partial by
  // definition; lines that also match the refund phrasing keep type 'refund'
  // so re-scans dedup against rows recorded before this pattern existed.
  const isPartial =
    /\bpartial\b/i.test(text) ||
    (PRODUCTION_COST_DONE.test(text) && !REFUND_DONE.test(text));
  return {
    appOrderId,
    type: isPartial ? 'partial_refund' : 'refund',
    amountUsd: amt ? parseAmount(amt[1]) : undefined,
    evidence: text,
  };
}

/**
 * Operator requests: a Patrizia line that asks for a refund/cancel/reprint and
 * names one or more orders, OR names orders right after such an ask. Best-effort
 * - used only to flag "awaiting Printify", never to claim money was recovered.
 */
function matchRequests(lines: Line[]): PrintifyRequest[] {
  const out: PrintifyRequest[] = [];
  // Track the operator's most recent stated intent so a follow-up line that is
  // just an order number ("#19269685.18017") inherits it.
  let activeIntent: PrintifyRequestIntent | null = null;

  for (const line of lines) {
    if (!isOperator(line.speaker)) continue;
    const t = line.text;
    const lower = t.toLowerCase();

    let lineIntent: PrintifyRequestIntent | null = null;
    if (/\brefund\b/.test(lower)) lineIntent = 'refund';
    else if (/\brepr?int\b|\breplace(?:ment)?\b/.test(lower)) lineIntent = 'reprint';
    else if (/\bcancel\b/.test(lower)) lineIntent = 'cancel';

    if (lineIntent) activeIntent = lineIntent;

    const ids = t.match(ORDER_ID_G);
    if (!ids) continue;

    // A line carrying order ids attributes them to its own intent if present,
    // otherwise to the operator's most recent intent.
    const intent = lineIntent || activeIntent;
    if (!intent) continue;
    for (const id of ids) {
      out.push({ appOrderId: id, intent, evidence: t });
    }
  }

  // De-dupe (operator often pastes the same id twice).
  const byId = new Map<string, PrintifyRequest>();
  for (const r of out) {
    if (!byId.has(r.appOrderId)) byId.set(r.appOrderId, r);
  }
  return [...byId.values()];
}

/**
 * Parse one Printify support email body (plaintext) into resolutions + requests.
 */
export function parsePrintifyEmail(body: string): ParsedPrintifyEmail {
  const lines = splitLines(body);
  const resolutions: PrintifyResolution[] = [];
  const seen = new Set<string>();

  // Pass 1: structured lines (highest confidence).
  for (const line of lines) {
    const r = matchStructured(line.text);
    if (r && !seen.has(r.appOrderId)) {
      resolutions.push(r);
      seen.add(r.appOrderId);
    }
  }

  // Pass 2: prose confirmations (skip orders already resolved structurally).
  for (let i = 0; i < lines.length; i++) {
    const r = matchProse(lines, i, seen, 'confirmed');
    if (r) {
      resolutions.push(r);
      seen.add(r.appOrderId);
    }
  }

  // Pass 3: explicit declines - only for orders with NO confirmed outcome in
  // this email, so a decline that was later reversed never wins.
  for (let i = 0; i < lines.length; i++) {
    const r = matchProse(lines, i, seen, 'declined');
    if (r) {
      resolutions.push(r);
      seen.add(r.appOrderId);
    }
  }

  // Requests, minus any order that already has a resolution in THIS email.
  const requests = matchRequests(lines).filter((r) => !seen.has(r.appOrderId));

  // Answers: the last agent/prose line mentioning each order, refund or not.
  // Operator lines are excluded (those are the questions, not the answers),
  // and a line must say something beyond the ids themselves to count.
  const answerById = new Map<string, string>();
  for (const line of lines) {
    if (isOperator(line.speaker)) continue;
    const ids = line.text.match(ORDER_ID_G);
    if (!ids) continue;
    const withoutIds = line.text.replace(ORDER_ID_G, '').trim();
    if (withoutIds.length < 20) continue;
    // The HTML-to-text conversion leaves markdown bold markers ("**pickup**")
    // in Zendesk emails - strip them so the row and the customer email stay
    // clean.
    const clean = line.text.replace(/\*\*/g, '').replace(/\s{2,}/g, ' ');
    for (const id of ids) {
      answerById.set(id, clean);
    }
  }
  const answers = [...answerById.entries()].map(([appOrderId, text]) => ({
    appOrderId,
    text,
  }));

  return { resolutions, requests, answers };
}
