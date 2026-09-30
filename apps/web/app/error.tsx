'use client';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="max-w-xl">
      <h1 className="text-2xl font-semibold">This page failed to load</h1>
      <p className="mt-2 text-ink-soft">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-lg border border-rule bg-sheet px-4 py-2 text-ink"
      >
        Try again
      </button>
    </div>
  );
}
