/**
 * Server-side cursor pagination for the directory-search tools.
 *
 * The point is to move the paging burden off the agent: instead of returning a
 * `nextCursor` and asking the model to call again (and pay tokens for every
 * intermediate page), these helpers walk the cursor internally up to a bounded
 * number of pages and hand back the accumulated rows.
 */

/** Default scan ceiling: up to 10 pages (~10k rows at Slack's 1000 page max). */
export const DEFAULT_MAX_PAGES = 10;

export interface Page<T> {
  items: T[];
  nextCursor: string | undefined;
}

export interface Collected<T> {
  items: T[];
  /** True if the page cap was hit with a cursor still pending (more remain). */
  truncated: boolean;
}

/**
 * Fetch successive pages via `fetchPage`, accumulating items until the cursor is
 * exhausted or `maxPages` is reached. A blank cursor is treated as exhausted.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<Collected<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor);
    items.push(...res.items);
    cursor = res.nextCursor !== undefined && res.nextCursor !== '' ? res.nextCursor : undefined;
    if (cursor === undefined) {
      return { items, truncated: false };
    }
  }
  return { items, truncated: true };
}
