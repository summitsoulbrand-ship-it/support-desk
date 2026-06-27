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
  | 'cancellation';

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

export interface ParsedPrintifyEmail {
  resolutions: PrintifyResolution[];
  requests: PrintifyRequest[];
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
  /\b(?:has\s+been|have\s+been|now\s+been|is\s+now|already)\b[^.]*\brefund(?:ed)?\b|\brefund\b[^.]*\b(?:has|have|now)\s+been\s+(?:issued|processed)\b|\brefund(?:ed)?\s+(?:of\s+)?USD\b/i;
const CANCEL_DONE =
  /\bprocessed\s+the\s+cancellation\b|\bhas\s+been\s+cancell?ed\b|\bcancellation\s+(?:has|was)\s+(?:been\s+)?(?:processed|completed|approved)\b/i;
const AMOUNT_USD = /USD\s+([\d.,]+)/i;

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
  seen: Set<string>
): PrintifyResolution | null {
  const line = lines[index];
  if (isOperator(line.speaker)) return null;
  const text = line.text;

  const isCancel = CANCEL_DONE.test(text);
  const isRefund = !isCancel && REFUND_DONE.test(text);
  if (!isCancel && !isRefund) return null;

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

  const amt = text.match(AMOUNT_USD);
  const isPartial = /\bpartial\b/i.test(text);
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
    const r = matchProse(lines, i, seen);
    if (r) {
      resolutions.push(r);
      seen.add(r.appOrderId);
    }
  }

  // Requests, minus any order that already has a resolution in THIS email.
  const requests = matchRequests(lines).filter((r) => !seen.has(r.appOrderId));

  return { resolutions, requests };
}
