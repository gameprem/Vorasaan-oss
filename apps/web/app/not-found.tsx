import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold">That page doesn't exist</h1>
      <p className="mt-2 text-ink-soft">
        The link may be wrong, or the request was removed.{' '}
        <Link href="/inbox" className="text-ink underline underline-offset-2">
          Go to your Inbox
        </Link>
      </p>
    </div>
  );
}
