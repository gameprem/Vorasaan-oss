// A grey placeholder in the shape of content that is still loading. Hidden from screen
// readers: the region that loads says "Loading" itself (aria-busy or a status).

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded-tile bg-surface-hi motion-reduce:animate-none ${className}`}
    />
  );
}

/** A few lines of text, the last one shorter. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span aria-hidden className="grid gap-2">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines
          key={i}
          className={`h-3.5 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`}
        />
      ))}
    </span>
  );
}
