import { notFound } from 'next/navigation';

// The page slot's fallback when a full load can't recover what it showed: not found,
// rather than an empty page.
export default function NoPage() {
  notFound();
}
