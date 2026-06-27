/**
 * Set the browser tab title for the current page, restoring the previous
 * title on unmount. Format: `<page> | AWS管理助手`.
 *
 * Pass `undefined` (or skip the page argument) to use the base title alone
 * — useful for the root account list page.
 *
 * Why a hook instead of react-helmet:
 *   The panel only has 3 pages and a single, fixed title format. A 6-line
 *   hook is plenty; pulling in a router-aware <head> manager would be
 *   overkill.
 */

import { useEffect } from 'react';

const BASE_TITLE = 'AWS管理助手';

export function usePageTitle(page?: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = page ? `${page} | ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = previous;
    };
  }, [page]);
}
