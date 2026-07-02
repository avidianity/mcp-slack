import Fuse from 'fuse.js';
import type { FuseOptionKey, IFuseOptions } from 'fuse.js';

/**
 * Fuzzy ranking for the directory-search tools, backed by fuse.js.
 *
 * Slack's Web API has no server-side search for channels or users, so those
 * tools page through `conversations.list` / `users.list` and rank rows locally.
 *
 * The shared options are tuned for identifier search (channel/user names,
 * emails) rather than long prose:
 *
 * - `ignoreLocation` — a match anywhere in the field counts; we are not doing
 *   near-the-start prefix search over documents.
 * - `threshold: 0.4` — tolerant enough to absorb small typos/transpositions
 *   ("genrl" → "general") while still rejecting unrelated strings. Fuse scores
 *   run 0 (perfect) → 1 (no match); 0.4 is Fuse's documented sweet spot for
 *   name-like data.
 * - `minMatchCharLength: 2` — ignore incidental single-character hits.
 * - `shouldSort` — return best matches first; callers slice off the top N.
 */
const BASE_OPTIONS: IFuseOptions<unknown> = {
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 2,
  shouldSort: true,
  includeScore: false,
};

/**
 * Rank `items` by fuzzy relevance of `query` across the given weighted `keys`,
 * dropping non-matches and returning best-first. An empty query or list yields
 * an empty result.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keys: readonly FuseOptionKey<T>[],
): T[] {
  const q = query.trim();
  if (q.length === 0 || items.length === 0) {
    return [];
  }
  const fuse = new Fuse(items, { ...BASE_OPTIONS, keys: keys as FuseOptionKey<T>[] });
  return fuse.search(q).map((result) => result.item);
}
