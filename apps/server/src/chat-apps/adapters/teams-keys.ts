import { Logger } from '@nestjs/common';
import { chatApiUrls, jsonObject, providerGetJson, str } from './http.ts';

/** A public signing key of the Bot Framework, as its JWKS lists it. */
export type Jwk = {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  /** The channels (e.g. "msteams") this key may sign for. */
  endorsements?: string[];
};

/** Where the Bot Framework's signing keys come from. Tests inject a fake JWKS. */
export interface TeamsKeySource {
  /** The current keys; `refresh` asks for a fresh fetch (throttled) when a kid is unknown. */
  keys(refresh?: boolean): Promise<Jwk[]>;
}

export const TEAMS_KEY_SOURCE = Symbol('TEAMS_KEY_SOURCE');

const DAY = 24 * 60 * 60 * 1000;
/** An unknown kid refetches at most this often, so unsigned requests can't cause a storm. */
const MIN_REFRESH_MS = 5 * 60 * 1000;
/** With no keys yet (the first fetch failed), try again at most this often. */
const RETRY_MS = 30 * 1000;

/**
 * The keys from the Bot Framework's OpenID metadata (its `jwks_uri`), cached for a day
 * as Microsoft recommends. The JWKS must be on the metadata's own origin.
 */
export class OpenIdKeySource implements TeamsKeySource {
  private readonly logger = new Logger('TeamsKeys');
  private cache: { keys: Jwk[]; at: number } | undefined;
  private lastFetch = 0;
  private inflight: Promise<Jwk[]> | undefined;

  constructor(
    private readonly metadataUrl: () => string = () => chatApiUrls().teamsOpenId,
    private readonly now: () => number = Date.now,
  ) {}

  async keys(refresh = false): Promise<Jwk[]> {
    const now = this.now();
    const fresh = this.cache && now - this.cache.at < DAY;
    const mayRefetch = refresh && now - this.lastFetch >= MIN_REFRESH_MS;
    if (this.cache && fresh && !mayRefetch) return this.cache.keys;
    if (!this.cache && now - this.lastFetch < RETRY_MS) return [];
    this.inflight ??= this.fetchKeys().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchKeys(): Promise<Jwk[]> {
    this.lastFetch = this.now();
    try {
      const metadataUrl = new URL(this.metadataUrl());
      const metadata = jsonObject(await providerGetJson('TEAMS', metadataUrl.toString()));
      const jwksUri = new URL(str(metadata?.jwks_uri) ?? '', metadataUrl);
      if (jwksUri.origin !== metadataUrl.origin) throw new Error('jwks_uri on another origin');
      const jwks = jsonObject(await providerGetJson('TEAMS', jwksUri.toString()));
      const keys = (Array.isArray(jwks?.keys) ? jwks.keys : []).filter(
        (k): k is Jwk => jsonObject(k) !== null,
      );
      this.cache = { keys, at: this.now() };
      return keys;
    } catch (error) {
      this.logger.warn(
        `Could not fetch the Bot Framework signing keys: ${(error as Error).message}`,
      );
      // Keep using the last keys we had; with none, nothing verifies.
      return this.cache?.keys ?? [];
    }
  }
}
