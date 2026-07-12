import type { Metadata } from 'next';

/**
 * Customer-facing self-service pages (cancel / withdraw / order portal).
 * Without this layout they inherit the app's internal "Support Desk" title -
 * customers should see the brand, not the name of our back-office tool.
 */
export const metadata: Metadata = {
  title: 'Summit Soul - Your order',
  description:
    'Track your Summit Soul order, fix the shipping address, change a size or color, or cancel.',
  robots: { index: false, follow: false },
};

export default function SelfServiceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
