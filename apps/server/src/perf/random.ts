/**
 * A seeded random source for the large Organization (ticket 0073): the same seed always
 * builds the same data, ids included, so two benchmark runs measure the same thing.
 * mulberry32: small, fast and good enough for test data (not for anything secret).
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Cannot pick from an empty list');
    return item;
  }

  /** One of the keys, with probability proportional to its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]?.[0] as K;
  }

  /** A version 4 UUID made of seeded bits, so ids repeat from run to run. */
  uuid(): string {
    const hex = Array.from({ length: 4 }, () =>
      Math.floor(this.next() * 0x1_0000_0000)
        .toString(16)
        .padStart(8, '0'),
    ).join('');
    const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}
