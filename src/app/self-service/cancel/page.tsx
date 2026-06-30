'use client';

/**
 * Public self-service cancel portal.
 *  - No token in URL: order-number + email form -> emails a magic link.
 *  - With ?token=: shows the order and a Cancel button (re-checked live by the
 *    API at click time).
 *
 * Self-contained inline styles so it renders standalone, off-brand-safe, with no
 * dependency on the dashboard's component library.
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
  maxWidth: 460,
  width: '100%',
  padding: 32,
};
const shell: React.CSSProperties = {
  width: '100%',
  maxWidth: 460,
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
const p: React.CSSProperties = { fontSize: 15, lineHeight: 1.5, color: '#374151' };
const label: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  margin: '16px 0 6px',
};
const input: React.CSSProperties = {
  width: '100%',
  padding: '11px 12px',
  fontSize: 15,
  border: '1px solid #d1d5db',
  borderRadius: 8,
  boxSizing: 'border-box',
};
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
  marginTop: 22,
};
const btnDisabled: React.CSSProperties = { ...btn, opacity: 0.55, cursor: 'default' };
const note: React.CSSProperties = { fontSize: 13, color: '#6b7280', marginTop: 18 };

interface Preview {
  orderName: string;
  maskedEmail: string;
  itemCount: number;
  total: string;
  eligible: boolean;
  reason: string;
  reasonMessage: string;
}

function LookupForm() {
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
      const res = await fetch('/api/self-service/request-link', {
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
          If that order number and email match an order, we just sent a
          cancellation link to that email address. The link expires in 30
          minutes.
        </p>
        <p style={note}>
          Didn&apos;t get it? Check spam, or email support@summitsoul.shop.
        </p>
      </div>
    );
  }

  return (
    <form style={card} onSubmit={submit}>
      <h1 style={h1}>Cancel your order</h1>
      <p style={p}>
        Changed your mind? You can cancel for a full refund as long as your order
        hasn&apos;t started printing yet. Enter your order number and email and
        we&apos;ll send a secure link.
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
        {sending ? 'Sending...' : 'Send cancellation link'}
      </button>
      <p style={note}>
        We&apos;ll only ever send the link to the email already on the order.
      </p>
    </form>
  );
}

function ConfirmCancel({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState('');
  const [actionErr, setActionErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/self-service/cancel?token=${encodeURIComponent(token)}`
        );
        const data = await res.json();
        if (!res.ok) setLoadErr(data.error || 'This link is invalid or expired.');
        else setPreview(data);
      } catch {
        setLoadErr('Something went wrong loading your order.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function cancel() {
    setActionErr('');
    setWorking(true);
    try {
      const res = await fetch('/api/self-service/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) setActionErr(data.error || 'We could not cancel this order.');
      else setDone(data.message || 'Your order has been cancelled.');
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
          <a href="/self-service/cancel" style={{ color: GREEN }}>
            Request a new link
          </a>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div style={card}>
        <h1 style={h1}>Order cancelled</h1>
        <p style={p}>{done}</p>
      </div>
    );
  }

  if (!preview) return null;

  if (!preview.eligible) {
    return (
      <div style={card}>
        <h1 style={h1}>Can&apos;t cancel automatically</h1>
        <p style={p}>{preview.reasonMessage}</p>
        <p style={note}>Order {preview.orderName}</p>
      </div>
    );
  }

  return (
    <div style={card}>
      <h1 style={h1}>Cancel order {preview.orderName}?</h1>
      <p style={p}>
        This will cancel your order and refund{' '}
        <strong>{preview.total}</strong> to your original payment method.
      </p>
      <div
        style={{
          background: '#f4f6f3',
          borderRadius: 10,
          padding: 16,
          margin: '18px 0',
          fontSize: 14,
        }}
      >
        <div>Order: {preview.orderName}</div>
        <div>Email: {preview.maskedEmail}</div>
        <div>Items: {preview.itemCount}</div>
        <div>Total: {preview.total}</div>
      </div>
      {actionErr && <p style={{ ...note, color: '#b91c1c' }}>{actionErr}</p>}
      <button style={working ? btnDisabled : btn} disabled={working} onClick={cancel}>
        {working ? 'Cancelling...' : 'Cancel my order & refund me'}
      </button>
      <p style={note}>This can&apos;t be undone. You&apos;d need to reorder.</p>
    </div>
  );
}

function Portal() {
  const token = useSearchParams().get('token');
  return (
    <div style={wrap}>
      <div style={shell}>
        <a href="https://summitsoul.shop" aria-label="Summit Soul home">
          <img
            src="https://summitsoul.shop/cdn/shop/files/Untitled_500_x_200_px_1.png"
            alt="Summit Soul"
            style={{ height: 38, width: 'auto', display: 'block' }}
          />
        </a>
        {token ? <ConfirmCancel token={token} /> : <LookupForm />}
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
