'use client';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="max-w-xl">
      <h1 className="text-2xl font-semibold">This page failed to load</h1>
      <p className="mt-2 text-fg-soft">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-full bg-surface px-4 py-2 font-semibold text-fg hover:bg-surface-hi"
      >
        Try again
      </button>
    </div>
  );
}
