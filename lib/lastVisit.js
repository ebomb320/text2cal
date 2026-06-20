// Each family member has their own private link, so their browser's
// localStorage naturally keeps their "what's new" badge state separate
// from everyone else's — no extra database table needed for this.

function key(memberId) {
  return `fc-last-visit-${memberId}`;
}

// Returns the timestamp of this member's previous visit (or null if first
// visit ever), then immediately stamps "now" for next time.
export function getAndAdvanceLastVisit(memberId) {
  if (typeof window === "undefined") return null;
  let previous = null;
  try {
    previous = window.localStorage.getItem(key(memberId));
  } catch {
    /* localStorage unavailable (private browsing, etc.) — badges just won't persist */
  }
  try {
    window.localStorage.setItem(key(memberId), new Date().toISOString());
  } catch {}
  return previous;
}
