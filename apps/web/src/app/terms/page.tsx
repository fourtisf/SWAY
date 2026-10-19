import type { Metadata } from 'next';
import { Terms } from '@/components/views/Legal';

export const metadata: Metadata = { title: 'Terms of Service · Sway' };

export default function TermsPage() {
  return <Terms />;
}
