// Each family member has their own private link, so their browser's
// localStorage naturally keeps their "what's new" badge state separate
// from everyone else's — no extra database table needed for this.

function key(memberId) {
  return `fc-last-visit-${memberId}`;
}

// Read-only — returns the previous visit timestamp without touching it.
// Call this on load so refreshing doesn't accidentally advance the cutoff.
export function getLastVisit(memberId) {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key(memberId)); } catch { return null; }
}

// Advance the timestamp to now — called only when the user actually leaves
// or backgrounds the app, so unviewed badges survive a refresh.
export function advanceLastVisit(memberId) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key(memberId), new Date().toISOString()); } catch {}
}
