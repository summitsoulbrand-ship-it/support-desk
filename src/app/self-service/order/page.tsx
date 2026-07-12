'use client';

/**
 * Public manage-order portal (status + one self-service action per link).
 *  - No token in URL: order-number + email form -> emails a magic link.
 *  - With ?token=: status view (tracking, items) plus - while the order is
 *    still pre-production - change size/color, fix the address, or cancel.
 *
 * All decisions are server-side; this page only renders what the API allows.
 * Pre-launch the APIs 404 without ?preview=<key>, which this page passes
 * through on every call. Mobile-first: most customers open this from the
 * order email on their phone.
 */

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const GREEN = '#2f5d3a';
const INK = '#1f2421';

const wrap: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  background: '#f4f6f3',
  padding: '48px 16px',
  fontFamily:
    '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
  color: INK,
};
const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 2px 18px rgba(0,0,0,0.07)',
  maxWidth: 520,
  width: '100%',
  padding: 28,
};
const shell: React.CSSProperties = {
  width: '100%',
  maxWidth: 520,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 18,
};
const backLink: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: GREEN,
  textDecoration: 'none',
};
const h1: React.CSSProperties = { color: GREEN, fontSize: 22, margin: '0 0 8px' };
const h2: React.CSSProperties = { color: INK, fontSize: 16, margin: '22px 0 8px' };
const p: React.CSSProperties = { fontSize: 15, lineHeight: 1.5, color: '#374151' };
const label: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  margin: '14px 0 6px',
};
const input: React.CSSProperties = {
  width: '100%',
  padding: '11px 12px',
  fontSize: 15,
  border: '1px solid #d1d5db',
  borderRadius: 8,
  boxSizing: 'border-box',
};
const select: React.CSSProperties = { ...input, background: '#fff' };
const btn: React.CSSProperties = {
  background: GREEN,
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '12px 20px',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  width: '100%',
  marginTop: 18,
};
const btnGhost: React.CSSProperties = {
  ...btn,
  background: '#fff',
  color: GREEN,
  border: `1.5px solid ${GREEN}`,
};
const btnDanger: React.CSSProperties = {
  ...btn,
  background: '#fff',
  color: '#b91c1c',
  border: '1.5px solid #dca3a3',
};
const btnDisabled: React.CSSProperties = { ...btn, opacity: 0.55, cursor: 'default' };
const note: React.CSSProperties = { fontSize: 13, color: '#6b7280', marginTop: 14 };
const badge = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block',
  background: bg,
  color: fg,
  borderRadius: 999,
  padding: '5px 14px',
  fontSize: 14,
  fontWeight: 700,
});
const itemRow: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  padding: '10px 0',
  borderBottom: '1px solid #f0f2ef',
};

interface OrderView {
  orderName: string;
  maskedEmail: string;
  createdAt: string;
  total: string;
  status: 'cancelled' | 'shipped' | 'printing' | 'editable' | 'needs_support';
  tracking: { number: string; url?: string; carrier?: string }[];
  isEu: boolean;
  deadlineCopy: string;
  canCancel: boolean;
  cancelBlockedMessage: string;
  canChangeItems: boolean;
  canChangeAddress: boolean;
  items: {
    lineItemId: string;
    title: string;
    variantTitle: string;
    quantity: number;
    imageUrl: string | null;
    options: { variantId: string; title: string }[];
  }[];
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2: string;
    city: string;
    zip: string;
    provinceCode: string;
    province: string;
    country: string;
    countryCode: string;
    phone: string;
  } | null;
}

const STATUS_COPY: Record<OrderView['status'], { label: string; bg: string; fg: string; blurb: string }> = {
  editable: {
    label: 'Getting ready',
    bg: '#e7f0e9',
    fg: GREEN,
    blurb: 'Your order is in - it has not started printing yet.',
  },
  printing: {
    label: 'Being made',
    bg: '#fdf3e3',
    fg: '#92600a',
    blurb: 'Your order is being printed just for you (this usually takes 2-5 business days), then it ships.',
  },
  shipped: {
    label: 'Shipped',
    bg: '#e8eefb',
    fg: '#1d4fa1',
    blurb: 'Your order is on its way.',
  },
  cancelled: {
    label: 'Cancelled',
    bg: '#f3f4f6',
    fg: '#4b5563',
    blurb: 'This order has been cancelled.',
  },
  needs_support: {
    label: 'With our team',
    bg: '#fdf3e3',
    fg: '#92600a',
    blurb: 'This order is getting a personal touch from our team. Email support@summitsoul.shop with any questions.',
  },
};

function LookupForm({ preview }: { preview: string | null }) {
  const [orderNumber, setOrderNumber] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setSending(true);
    try {
      const qs = preview ? `?preview=${encodeURIComponent(preview)}` : '';
      const res = await fetch(`/api/self-service/request-link${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, email }),
      });
      if (res.status === 429) {
        setErr('Too many requests. Please try again in a little while.');
      } else if (res.status === 404) {
        const data = await res.json().catch(() => ({}));
        setErr(
          data.message ||
            "We couldn't find an order with that number. Double-check it and try again."
        );
      } else {
        setSent(true);
      }
    } catch {
      setErr('Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div style={card}>
        <h1 style={h1}>Check your email</h1>
        <p style={p}>
          If that order number and email match an order, we just sent a secure
          link to that email address. The link expires in 30 minutes.
        </p>
        <p style={note}>
          Didn&apos;t get it? Check spam, or email support@summitsoul.shop.
        </p>
      </div>
    );
  }

  return (
    <form style={card} onSubmit={submit}>
      <h1 style={h1}>Track or change your order</h1>
      <p style={p}>
        See where your order is, fix the shipping address, change a size or
        color, or cancel - all from one secure link. Enter your order number
        and email and we&apos;ll send it over.
      </p>
      <label style={label}>Order number</label>
      <input
        style={input}
        placeholder="#12345"
        value={orderNumber}
        onChange={(e) => setOrderNumber(e.target.value)}
        required
      />
      <label style={label}>Email on the order</label>
      <input
        style={input}
        type="email"
        placeholder="you@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      {err && <p style={{ ...note, color: '#b91c1c' }}>{err}</p>}
      <button style={sending ? btnDisabled : btn} disabled={sending}>
        {sending ? 'Sending...' : 'Email me my order link'}
      </button>
      <p style={note}>
        We&apos;ll only ever send the link to the email already on the order.
      </p>
    </form>
  );
}

type Panel = 'none' | 'items' | 'address' | 'cancel';

function OrderPortal({ token, preview }: { token: string; preview: string | null }) {
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<OrderView | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [panel, setPanel] = useState<Panel>('none');
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState('');
  const [actionErr, setActionErr] = useState('');

  // Item change state
  const [pickedVariant, setPickedVariant] = useState<Record<string, string>>({});
  // Address state
  const [addr, setAddr] = useState({
    firstName: '',
    lastName: '',
    address1: '',
    address2: '',
    city: '',
    zip: '',
    provinceCode: '',
    phone: '',
  });

  const qs = (path: string) =>
    `${path}${preview ? `?preview=${encodeURIComponent(preview)}` : ''}`;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/self-service/order?token=${encodeURIComponent(token)}${
            preview ? `&preview=${encodeURIComponent(preview)}` : ''
          }`
        );
        const data = await res.json();
        if (!res.ok) setLoadErr(data.error || 'This link is invalid or expired.');
        else {
          setView(data);
          if (data.shippingAddress) {
            setAddr({
              firstName: data.shippingAddress.firstName,
              lastName: data.shippingAddress.lastName,
              address1: data.shippingAddress.address1,
              address2: data.shippingAddress.address2,
              city: data.shippingAddress.city,
              zip: data.shippingAddress.zip,
              provinceCode: data.shippingAddress.provinceCode,
              phone: data.shippingAddress.phone,
            });
          }
        }
      } catch {
        setLoadErr('Something went wrong loading your order.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token, preview]);

  async function post(path: string, body: Record<string, unknown>) {
    setActionErr('');
    setWorking(true);
    try {
      const res = await fetch(qs(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...body }),
      });
      const data = await res.json();
      if (!res.ok) setActionErr(data.error || 'That did not work. Please try again.');
      else setDone(data.message || 'Done.');
    } catch {
      setActionErr('Something went wrong. Please try again.');
    } finally {
      setWorking(false);
    }
  }

  if (loading) {
    return (
      <div style={card}>
        <p style={p}>Loading your order...</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div style={card}>
        <h1 style={h1}>Link expired</h1>
        <p style={p}>{loadErr}</p>
        <p style={note}>
          <a href={qs('/self-service/order')} style={{ color: GREEN }}>
            Request a new link
          </a>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div style={card}>
        <h1 style={h1}>All set</h1>
        <p style={p}>{done}</p>
        <p style={note}>
          Need anything else? Request a fresh link from{' '}
          <a href={qs('/self-service/order')} style={{ color: GREEN }}>
            this page
          </a>{' '}
          - each link covers one change.
        </p>
      </div>
    );
  }

  if (!view) return null;
  const sc = STATUS_COPY[view.status];

  return (
    <div style={card}>
      <h1 style={h1}>Order {view.orderName}</h1>
      <div style={{ margin: '10px 0 6px' }}>
        <span style={badge(sc.bg, sc.fg)}>{sc.label}</span>
      </div>
      <p style={p}>{sc.blurb}</p>

      {view.tracking.length > 0 && (
        <>
          <h2 style={h2}>Tracking</h2>
          {view.tracking.map((t) => (
            <p key={t.number} style={{ ...p, margin: '4px 0' }}>
              {t.carrier ? `${t.carrier}: ` : ''}
              {t.url ? (
                <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ color: GREEN, fontWeight: 600 }}>
                  {t.number}
                </a>
              ) : (
                t.number
              )}
            </p>
          ))}
        </>
      )}

      <h2 style={h2}>Items</h2>
      <div>
        {view.items.map((it) => (
          <div key={it.lineItemId} style={itemRow}>
            {it.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.imageUrl}
                alt=""
                style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
              />
            )}
            <div style={{ fontSize: 14, lineHeight: 1.45 }}>
              <div style={{ fontWeight: 600 }}>{it.title}</div>
              <div style={{ color: '#6b7280' }}>
                {it.variantTitle}
                {it.quantity > 1 ? ` x ${it.quantity}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p style={{ ...note, marginTop: 10 }}>
        Total {view.total} - placed {new Date(view.createdAt).toLocaleDateString()}
      </p>

      {view.deadlineCopy && <p style={{ ...note, color: '#92600a' }}>{view.deadlineCopy}</p>}

      {(view.canChangeItems || view.canChangeAddress || view.canCancel) && (
        <>
          <h2 style={h2}>Make a change</h2>
          {panel === 'none' && (
            <>
              {view.canChangeItems && (
                <button style={btnGhost} onClick={() => setPanel('items')}>
                  Change a size or color
                </button>
              )}
              {view.canChangeAddress && (
                <button style={btnGhost} onClick={() => setPanel('address')}>
                  Fix the shipping address
                </button>
              )}
              {view.canCancel && (
                <button style={btnDanger} onClick={() => setPanel('cancel')}>
                  {view.isEu ? 'Withdraw from this order (full refund)' : 'Cancel this order (full refund)'}
                </button>
              )}
            </>
          )}

          {panel === 'items' && (
            <div>
              <p style={p}>
                Pick the new size or color for an item. Same price only - swaps
                that change the price go through support@summitsoul.shop.
              </p>
              {view.items.map((it) =>
                it.options.length === 0 ? null : (
                  <div key={it.lineItemId}>
                    <label style={label}>
                      {it.title} (currently {it.variantTitle})
                    </label>
                    <select
                      style={select}
                      value={pickedVariant[it.lineItemId] || ''}
                      onChange={(e) =>
                        // one change per link - picking here clears other rows
                        setPickedVariant(
                          e.target.value ? { [it.lineItemId]: e.target.value } : {}
                        )
                      }
                    >
                      <option value="">Keep {it.variantTitle}</option>
                      {it.options.map((o) => (
                        <option key={o.variantId} value={o.variantId}>
                          {o.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              )}
              {actionErr && <p style={{ ...note, color: '#b91c1c' }}>{actionErr}</p>}
              <button
                style={working || Object.keys(pickedVariant).length === 0 ? btnDisabled : btn}
                disabled={working || Object.keys(pickedVariant).length === 0}
                onClick={() => {
                  const [lineItemId, newVariantId] = Object.entries(pickedVariant)[0];
                  post('/api/self-service/item-change', { lineItemId, newVariantId });
                }}
              >
                {working ? 'Applying...' : 'Apply this change'}
              </button>
              <button style={{ ...btnGhost, marginTop: 10 }} onClick={() => setPanel('none')} disabled={working}>
                Back
              </button>
              <p style={note}>One change per link - you can always request another link after.</p>
            </div>
          )}

          {panel === 'address' && view.shippingAddress && (
            <div>
              <p style={p}>
                Update where this order ships. Country stays{' '}
                <strong>{view.shippingAddress.country || view.shippingAddress.countryCode}</strong> - for a
                different country, email support@summitsoul.shop.
              </p>
              <label style={label}>First name</label>
              <input style={input} value={addr.firstName} onChange={(e) => setAddr({ ...addr, firstName: e.target.value })} />
              <label style={label}>Last name</label>
              <input style={input} value={addr.lastName} onChange={(e) => setAddr({ ...addr, lastName: e.target.value })} />
              <label style={label}>Street address</label>
              <input style={input} value={addr.address1} onChange={(e) => setAddr({ ...addr, address1: e.target.value })} required />
              <label style={label}>Apt / unit (optional)</label>
              <input style={input} value={addr.address2} onChange={(e) => setAddr({ ...addr, address2: e.target.value })} />
              <label style={label}>City</label>
              <input style={input} value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} required />
              <label style={label}>State / province code</label>
              <input style={input} value={addr.provinceCode} placeholder="CA" onChange={(e) => setAddr({ ...addr, provinceCode: e.target.value })} />
              <label style={label}>ZIP / postal code</label>
              <input style={input} value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} required />
              {actionErr && <p style={{ ...note, color: '#b91c1c' }}>{actionErr}</p>}
              <button
                style={working ? btnDisabled : btn}
                disabled={working}
                onClick={() =>
                  post('/api/self-service/address', {
                    address: {
                      firstName: addr.firstName || undefined,
                      lastName: addr.lastName || undefined,
                      address1: addr.address1,
                      address2: addr.address2 || undefined,
                      city: addr.city,
                      zip: addr.zip,
                      provinceCode: addr.provinceCode || undefined,
                      phone: addr.phone || undefined,
                    },
                  })
                }
              >
                {working ? 'Saving...' : 'Save new address'}
              </button>
              <button style={{ ...btnGhost, marginTop: 10 }} onClick={() => setPanel('none')} disabled={working}>
                Back
              </button>
            </div>
          )}

          {panel === 'cancel' && (
            <div>
              <p style={p}>
                This will {view.isEu ? 'withdraw from' : 'cancel'} order{' '}
                <strong>{view.orderName}</strong> and refund <strong>{view.total}</strong> to
                your original payment method. It can&apos;t be undone - you&apos;d need to reorder.
              </p>
              {actionErr && <p style={{ ...note, color: '#b91c1c' }}>{actionErr}</p>}
              <button
                style={working ? btnDisabled : { ...btn, background: '#b91c1c' }}
                disabled={working}
                onClick={() => post(view.isEu ? '/api/self-service/withdraw' : '/api/self-service/cancel', {})}
              >
                {working
                  ? 'Working...'
                  : view.isEu
                    ? 'Withdraw & refund me'
                    : 'Cancel my order & refund me'}
              </button>
              <button style={{ ...btnGhost, marginTop: 10 }} onClick={() => setPanel('none')} disabled={working}>
                Back
              </button>
            </div>
          )}
        </>
      )}

      {!view.canCancel && view.cancelBlockedMessage && view.status !== 'cancelled' && view.status !== 'shipped' && (
        <p style={note}>{view.cancelBlockedMessage}</p>
      )}
    </div>
  );
}

function Portal() {
  const params = useSearchParams();
  const token = params.get('token');
  const preview = params.get('preview');
  return (
    <div style={wrap}>
      <div style={shell}>
        <a href="https://summitsoul.shop" aria-label="Summit Soul home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://summitsoul.shop/cdn/shop/files/Untitled_500_x_200_px_1.png"
            alt="Summit Soul"
            style={{ height: 38, width: 'auto', display: 'block' }}
          />
        </a>
        {token ? <OrderPortal token={token} preview={preview} /> : <LookupForm preview={preview} />}
        <a href="https://summitsoul.shop" style={backLink}>&larr; Back to summitsoul.shop</a>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div style={wrap} />}>
      <Portal />
    </Suspense>
  );
}
