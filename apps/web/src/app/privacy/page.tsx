import type { Metadata } from 'next';
import { Privacy } from '@/components/views/Legal';

export const metadata: Metadata = { title: 'Privacy Policy · Sway' };

export default function PrivacyPage() {
  return <Privacy />;
}
