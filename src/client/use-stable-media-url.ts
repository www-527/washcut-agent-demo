import {useEffect, useRef} from 'react';

const MEDIA_URL_RENEWAL_WINDOW_SECONDS = 5 * 60;

const stableSearchParams = (url: URL) => [...url.searchParams.entries()]
  .filter(([name]) => name !== 'expires' && name !== 'signature')
  .sort(([leftName, leftValue], [rightName, rightValue]) => leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));

export const canReuseMediaUrl = (currentUrl: string, candidateUrl: string, nowMs = Date.now()) => {
  if (currentUrl === candidateUrl) return true;
  try {
    const current = new URL(currentUrl);
    const candidate = new URL(candidateUrl);
    const expires = Number(current.searchParams.get('expires'));
    return current.origin === candidate.origin
      && current.pathname === candidate.pathname
      && current.hash === candidate.hash
      && JSON.stringify(stableSearchParams(current)) === JSON.stringify(stableSearchParams(candidate))
      && Number.isInteger(expires)
      && expires > Math.floor(nowMs / 1_000) + MEDIA_URL_RENEWAL_WINDOW_SECONDS;
  } catch {
    return false;
  }
};

export const useStableMediaUrl = (resourceRevision: string, candidateUrl: string) => {
  const stableRef = useRef({resourceRevision, url: candidateUrl});
  const stableUrl = stableRef.current.resourceRevision === resourceRevision
    && canReuseMediaUrl(stableRef.current.url, candidateUrl)
    ? stableRef.current.url
    : candidateUrl;

  useEffect(() => {
    stableRef.current = {resourceRevision, url: stableUrl};
  }, [resourceRevision, stableUrl]);

  return stableUrl;
};
