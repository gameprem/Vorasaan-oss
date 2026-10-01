import { notFound } from 'next/navigation';

// The modal slot's catch-all matches every URL, so an unknown one reaches the page slot
// here instead of 404ing on its own.
export default function NoPage() {
  notFound();
}
