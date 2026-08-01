/**
 * Message-ID helpers for reply threading.
 *
 * Two different kinds of id end up in `messages.provider_message_id`:
 *
 *  - INBOUND rows hold the real RFC-5322 Message-ID, e.g.
 *    `<PH0PR02MB7702...@outlook.com>`
 *  - OUTBOUND rows hold whatever the sender handed back. The Zoho Mail API
 *    returns its own internal number, e.g. `1785287639537155100`, which is NOT
 *    the id stamped on the email that reached the customer.
 *
 * Putting that number into In-Reply-To / References produced a chain the
 * customer's mail client could not follow, so replies came back pointing at an
 * id we had never stored, matched no thread, and opened duplicates. Anything
 * heading into a threading header has to pass `isRfcMessageId` first.
 */

/** True for a real RFC-5322 Message-ID: `<something@somewhere>`. */
export function isRfcMessageId(id: string | null | undefined): id is string {
  if (!id) return false;
  const trimmed = id.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.includes('@');
}

/**
 * The real Message-ID for a stored message, or undefined when we only have a
 * provider-internal id. `rfcMessageId` wins: on outbound rows it is the id we
 * learned from the customer's own reply headers.
 */
export function rfcIdOf(
  message: { rfcMessageId?: string | null; providerMessageId?: string | null } | null | undefined
): string | undefined {
  if (!message) return undefined;
  if (isRfcMessageId(message.rfcMessageId)) return message.rfcMessageId.trim();
  if (isRfcMessageId(message.providerMessageId)) return message.providerMessageId.trim();
  return undefined;
}
