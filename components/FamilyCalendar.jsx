"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  getEvents,
  getMembers,
  getSettings,
  insertEvents as dbInsertEvents,
  softDeleteEvent as dbSoftDeleteEvent,
  restoreEvent as dbRestoreEvent,
  updateSettingsTitle,
  updateMember,
  purgeOldDeleted,
  subscribeToChanges,
} from "../lib/calendarData";
import { getAndAdvanceLastVisit } from "../lib/lastVisit";

const memberById = (members, id) => members.find((m) => m.id === id) || members[0];
const COLOR_OPTIONS = ["#8A5CF6", "#4A7CFA", "#F25C8A", "#34A06B", "#F2994A", "#E55050", "#2BB3B3", "#9B6B43"];

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["S","M","T","W","T","F","S"];
const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

const toKey = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// Simple parser that mimics what an SMS backend would do (a future, fuller
// version could use AI parsing for far more phrasings).

// Find the first date in a string. Returns {y, m, d, matched} or null.
// `ref` lets a bare day number ("22") inherit a month/year, for ranges like "June 20-22".
function matchSingleDate(str, ref) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < 12; i++) {
    const mn = MONTHS[i].toLowerCase();
    const re = new RegExp(`\\b(${mn}|${mn.slice(0, 3)})\\.?\\s*(\\d{1,2})\\b`, "i");
    const m = str.match(re);
    if (m) {
      let y = now.getFullYear();
      if (new Date(y, i, +m[2]) < startOfToday) y++;
      return { y, m: i, d: +m[2], matched: m[0] };
    }
  }
  const num = str.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (num) {
    let y = now.getFullYear();
    if (new Date(y, +num[1] - 1, +num[2]) < startOfToday) y++;
    return { y, m: +num[1] - 1, d: +num[2], matched: num[0] };
  }
  const td = str.match(/\btoday\b/i);
  if (td) return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate(), matched: td[0] };
  const tmr = str.match(/\btomorrow\b/i);
  if (tmr) {
    const t = new Date(now); t.setDate(t.getDate() + 1);
    return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate(), matched: tmr[0] };
  }
  for (let i = 0; i < 7; i++) {
    const wd = WEEKDAYS[i];
    const re = new RegExp(`\\b(next\\s+)?(${wd}|${wd.slice(0, 3)})\\b`, "i");
    const m = str.match(re);
    if (m) {
      const t = new Date(now);
      let diff = (i - t.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      t.setDate(t.getDate() + diff);
      return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate(), matched: m[0] };
    }
  }
  if (ref) {
    const bare = str.match(/^\s*(\d{1,2})\b/);
    if (bare) return { y: ref.y, m: ref.m, d: +bare[1], matched: bare[0] };
  }
  return null;
}

function parseText(raw, defaultMemberId) {
  const text = raw.trim();
  if (!text) return null;
  const now = new Date();
  let stripped = text;

  // Time, possibly a duration: "9am", "6:30pm", "1-4pm", "11am-1pm", "1:30 to 2:45pm"
  let time = "";
  let endTime = "";
  const fmtTime = (h, min, period) => `${h}:${min || "00"} ${period.toUpperCase()}`;
  const rangeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|[-–—])\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  const rmatch = text.match(rangeRe);
  if (rmatch) {
    const [, h1, m1, p1raw, h2, m2, p2raw] = rmatch;
    const p2 = p2raw.toLowerCase();
    let p1 = p1raw ? p1raw.toLowerCase() : null;
    if (!p1) {
      p1 = (+h1 <= +h2) ? p2 : (p2 === "pm" ? "am" : "pm");
    }
    time = fmtTime(h1, m1, p1);
    endTime = fmtTime(h2, m2, p2);
    stripped = stripped.replace(rmatch[0], "");
  } else {
    const tmatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (tmatch) {
      time = fmtTime(tmatch[1], tmatch[2], tmatch[3]);
      stripped = stripped.replace(tmatch[0], "");
    }
  }

  // Dates: single day, ranges ("7/3 to 7/4", "June 20-22"),
  // and lists ("7/21 and 7/28", "7/1, 7/8 & 7/15") — ranges allowed inside lists
  const occurrences = [];
  const first = matchSingleDate(stripped);
  if (first) {
    const idx = stripped.toLowerCase().indexOf(first.matched.toLowerCase());
    const before = stripped.slice(0, idx);
    let after = stripped.slice(idx + first.matched.length);

    const takeRangeEnd = (startObj) => {
      const conn = after.match(/^\s*(to|through|thru|until|till|[-–—])\s*/i);
      if (!conn) return null;
      const tail = after.slice(conn[0].length);
      const second = matchSingleDate(tail, { y: startObj.y, m: startObj.m });
      if (second && tail.toLowerCase().indexOf(second.matched.toLowerCase()) === 0) {
        if (new Date(second.y, second.m, second.d) < new Date(startObj.y, startObj.m, startObj.d)) second.y += 1;
        after = tail.slice(second.matched.length);
        return second;
      }
      return null;
    };

    let end = takeRangeEnd(first);
    occurrences.push({ date: toKey(first.y, first.m, first.d), endDate: end ? toKey(end.y, end.m, end.d) : null });
    let last = end || first;

    while (true) {
      const conn = after.match(/^\s*(and|&|,|plus|also)\s*/i);
      if (!conn) break;
      const tail = after.slice(conn[0].length);
      const next = matchSingleDate(tail, { y: last.y, m: last.m });
      if (!next || tail.toLowerCase().indexOf(next.matched.toLowerCase()) !== 0) break;
      after = tail.slice(next.matched.length);
      const nextEnd = takeRangeEnd(next);
      occurrences.push({ date: toKey(next.y, next.m, next.d), endDate: nextEnd ? toKey(nextEnd.y, nextEnd.m, nextEnd.d) : null });
      last = nextEnd || next;
    }

    stripped = before + " " + after;
  }
  if (!occurrences.length) {
    occurrences.push({ date: toKey(now.getFullYear(), now.getMonth(), now.getDate()), endDate: null });
  }
  occurrences.forEach((o) => { if (o.endDate === o.date) o.endDate = null; });

  // Every activity is tagged under whoever's link sent it — no keyword
  // logic involved, the sender always owns what they post.
  const member = defaultMemberId || "family";
  stripped = stripped.replace(/\bfor\s+(the\s+)?(kids?|wife|mom|family|everyone|me)\b/gi, "");

  let title = stripped.replace(/\b(on|at|next)\b/gi, " ").replace(/\s{2,}/g, " ").trim().replace(/^[,.\-–]+|[,.\-–]+$/g, "").trim();
  if (!title) title = text;
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return { title, time, endTime, member, occurrences };
}

// Expand an event's start..end dates into individual day keys (capped at 62 days)
function eventDays(ev) {
  if (!ev.endDate) return [ev.date];
  const days = [];
  const cur = new Date(ev.date + "T12:00:00");
  const end = new Date(ev.endDate + "T12:00:00");
  let guard = 0;
  while (cur <= end && guard < 62) {
    days.push(toKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return days;
}

function timeLabel(ev) {
  if (!ev.time) return "";
  return ev.endTime ? `${ev.time} – ${ev.endTime}` : ev.time;
}

function rangeLabel(ev) {
  if (!ev.endDate) return "";
  const f = (k) => new Date(k + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(ev.date)} – ${f(ev.endDate)}`;
}

function useWindowWidth() {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 480));
  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return width;
}

// Swipeable event row:
//  - small swipe → reveals a Delete button (tap it to confirm via dialog)
//  - full swipe across → deletes immediately (soft delete + Undo toast)
function EventRow({ ev, members, onDelete, onSwipeDelete }) {
  const m = memberById(members, ev.member);
  const rowRef = useRef(null);
  const startXRef = useRef(null);
  const widthRef = useRef(0);
  const [offsetX, setOffsetX] = useState(0);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [armed, setArmed] = useState(false);
  const PARTIAL = 60;
  const REVEAL = 96;
  const FULL_RATIO = 0.55;

  const onTouchStart = (e) => {
    startXRef.current = e.touches[0].clientX;
    widthRef.current = rowRef.current ? rowRef.current.offsetWidth : 300;
    setDragging(true);
    setArmed(false);
  };
  const onTouchMove = (e) => {
    if (startXRef.current === null) return;
    const dx = e.touches[0].clientX - startXRef.current;
    if (dx < 0) {
      const clamped = Math.max(dx, -widthRef.current);
      setOffsetX(clamped);
      setArmed(-clamped >= widthRef.current * FULL_RATIO);
    } else if (open && dx > 10) { setOpen(false); setOffsetX(0); setArmed(false); }
  };
  const onTouchEnd = () => {
    setDragging(false);
    const dx = -offsetX;
    if (dx >= widthRef.current * FULL_RATIO) {
      setRemoving(true);
      setOffsetX(-widthRef.current);
      setTimeout(() => onSwipeDelete(ev.id), 200);
    } else if (dx >= PARTIAL) {
      setOpen(true);
      setOffsetX(-REVEAL);
      setArmed(false);
    } else {
      setOpen(false);
      setOffsetX(0);
      setArmed(false);
    }
    startXRef.current = null;
  };

  return (
    <div style={{ position: "relative", overflow: "hidden", borderTop: "1px solid #F3EFE6" }}>
      <div style={{ position: "absolute", inset: 0, background: armed ? "#B73330" : "#D64541", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 22px", transition: "background 0.15s ease" }}>
        <button onClick={() => onDelete(ev)}
          style={{ border: "none", background: "none", color: "#fff", fontWeight: armed ? 900 : 700, fontSize: armed ? 15 : 13, transform: armed ? "scale(1.12)" : "scale(1)", transition: "all 0.15s ease", cursor: "pointer" }}>
          Delete
        </button>
      </div>
      <div
        ref={rowRef}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", background: "#fff", transform: `translateX(${open ? -REVEAL : offsetX}px)`, opacity: removing ? 0 : 1, transition: dragging ? "none" : "transform 0.2s ease, opacity 0.2s ease", userSelect: "none" }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 99, background: m.color, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{ev.title}</div>
          <div style={{ fontSize: 12, opacity: 0.55 }}>{[timeLabel(ev), rangeLabel(ev), m.name].filter(Boolean).join(" · ")}</div>
          {ev.createdAt && (
            <div style={{ fontSize: 10.5, opacity: 0.35, marginTop: 2 }}>
              Added {new Date(ev.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at {new Date(ev.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </div>
          )}
        </div>
        <button onClick={() => onDelete(ev)} aria-label="Delete" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, opacity: 0.35, flexShrink: 0, padding: 4 }}>✕</button>
      </div>
    </div>
  );
}

function Badge({ count }) {
  return (
    <span style={{
      position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, padding: "0 4px",
      borderRadius: 99, background: "#D64541", color: "#fff", fontSize: 11, fontWeight: 800,
      display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
      border: "2px solid #FBF9F4", pointerEvents: "none",
    }}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

export default function FamilyCalendar({ currentUser, members: initialMembers, initialTitle }) {
  const today = new Date();
  const windowWidth = useWindowWidth();
  const isWide = windowWidth >= 640;
  const todayKey = toKey(today.getFullYear(), today.getMonth(), today.getDate());

  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showTrash, setShowTrash] = useState(false);
  const [title, setTitle] = useState(initialTitle || "Family Calendar");
  const [editingTitle, setEditingTitle] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [pickerYear, setPickerYear] = useState(today.getFullYear());
  const [previousVisit, setPreviousVisit] = useState(null);
  const [seenIds, setSeenIds] = useState(() => new Set());
  const [members, setMembers] = useState(initialMembers);
  const [showEditNames, setShowEditNames] = useState(false);

  const gridSwipeX = useRef(null);
  const gridSwipeY = useRef(null);

  // Load this family's events from Supabase, quietly purge old trash,
  // and read/advance this person's own "last visit" timestamp.
  useEffect(() => {
    (async () => {
      try {
        const evs = await getEvents();
        setEvents(evs);
      } catch (err) {
        console.error("Failed to load events:", err);
      }
      purgeOldDeleted().catch(() => {});
      setPreviousVisit(getAndAdvanceLastVisit(currentUser.id));
      setLoaded(true);
    })();
  }, [currentUser.id]);

  // Stay live: push updates the instant anyone else adds, edits, or
  // deletes something, without needing a manual refresh.
  useEffect(() => {
    const unsubscribe = subscribeToChanges(
      () => getEvents().then(setEvents).catch((err) => console.error("Live events refresh failed:", err)),
      () => getMembers().then(setMembers).catch((err) => console.error("Live members refresh failed:", err)),
      () => getSettings().then(setTitle).catch((err) => console.error("Live title refresh failed:", err))
    );
    return unsubscribe;
  }, []);

  // Safety net: if the phone was locked/backgrounded and missed a live
  // update, catch up the moment the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        getEvents().then(setEvents).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const saveTitle = (next) => {
    const clean = next.trim() || "Family Calendar";
    setTitle(clean);
    setEditingTitle(false);
    updateSettingsTitle(clean).catch((err) => console.error("Failed to save title:", err));
  };

  const saveMemberName = (id, next) => {
    const clean = next.trim();
    if (!clean) return;
    setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, name: clean } : m)));
    updateMember(id, { name: clean }).catch((err) => console.error("Failed to save name:", err));
  };

  const saveMemberColor = (id, color) => {
    setMembers((ms) => ms.map((m) => (m.id === id ? { ...m, color } : m)));
    updateMember(id, { color }).catch((err) => console.error("Failed to save color:", err));
  };

  const byDate = useMemo(() => {
    const active = events.filter((ev) => !ev.deletedAt);
    const visible = filter.length ? active.filter((ev) => filter.includes(ev.member)) : active;
    const map = {};
    for (const ev of visible) for (const k of eventDays(ev)) (map[k] = map[k] || []).push(ev);
    for (const k in map) map[k].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    return map;
  }, [events, filter]);

  const countsByMonth = useMemo(() => {
    const map = {};
    for (const dateKey in byDate) {
      const ym = dateKey.slice(0, 7);
      map[ym] = (map[ym] || 0) + byDate[dateKey].length;
    }
    return map;
  }, [byDate]);

  const deletedEvents = useMemo(
    () => events.filter((ev) => ev.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)),
    [events]
  );

  const updateCounts = useMemo(() => {
    const byMember = {};
    let trash = 0;
    if (previousVisit) {
      const cutoff = new Date(previousVisit).getTime();
      for (const ev of events) {
        if (seenIds.has(ev.id)) continue;
        if (ev.createdAt && new Date(ev.createdAt).getTime() > cutoff && !ev.deletedAt) {
          byMember[ev.member] = (byMember[ev.member] || 0) + 1;
        }
        if (ev.deletedAt && new Date(ev.deletedAt).getTime() > cutoff) {
          trash++;
        }
      }
    }
    const total = Object.values(byMember).reduce((a, b) => a + b, 0);
    return { byMember, trash, total };
  }, [events, previousVisit, seenIds]);

  useEffect(() => {
    if (!selected) return;
    const ids = (byDate[selected] || []).map((ev) => ev.id);
    if (!ids.length) return;
    setSeenIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ids) if (!next.has(id)) { next.add(id); changed = true; }
      return changed ? next : prev;
    });
  }, [selected, byDate]);

  useEffect(() => {
    if (!showTrash || !deletedEvents.length) return;
    setSeenIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const ev of deletedEvents) if (!next.has(ev.id)) { next.add(ev.id); changed = true; }
      return changed ? next : prev;
    });
  }, [showTrash, deletedEvents]);

  const toggleFilter = (id) =>
    setFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  const jumpToMemberUpdate = (memberId) => {
    if (!previousVisit) return;
    const cutoff = new Date(previousVisit).getTime();
    const candidates = events.filter((ev) =>
      ev.member === memberId && !ev.deletedAt && !seenIds.has(ev.id) &&
      ev.createdAt && new Date(ev.createdAt).getTime() > cutoff
    );
    if (!candidates.length) return;
    candidates.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    const upcoming = candidates.filter((ev) => ev.date >= todayKey);
    const target = upcoming[0] || candidates[0];
    const d = new Date(target.date + "T12:00:00");
    setFilter([memberId]);
    setView({ y: d.getFullYear(), m: d.getMonth() });
    setSelected(target.date);
    setShowMonthPicker(false);
  };

  const firstDow = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const [flipDir, setFlipDir] = useState(0);
  const [flipKey, setFlipKey] = useState(0);

  const shift = (dir) => {
    setSelected(null);
    setFlipDir(dir);
    setFlipKey((k) => k + 1);
    setView((v) => {
      const m = v.m + dir;
      if (m < 0) return { y: v.y - 1, m: 11 };
      if (m > 11) return { y: v.y + 1, m: 0 };
      return { ...v, m };
    });
  };

  // Optimistic update + background DB write. These act on events that
  // already exist in the database, so there's no id-mismatch risk.
  const deleteEvent = (id) => {
    setEvents((e) => e.map((ev) => (ev.id === id ? { ...ev, deletedAt: new Date().toISOString(), deletedBy: currentUser.id } : ev)));
    setToast({ msg: "Activity deleted", undoId: id });
    setTimeout(() => setToast((t) => (t && t.undoId === id ? null : t)), 5000);
    dbSoftDeleteEvent(id, currentUser.id).catch((err) => console.error("Failed to delete:", err));
  };

  const restoreEvent = (id) => {
    setEvents((e) => e.map((ev) => {
      if (ev.id !== id) return ev;
      const { deletedAt, deletedBy, ...rest } = ev;
      return rest;
    }));
    setToast(null);
    dbRestoreEvent(id).catch((err) => console.error("Failed to restore:", err));
  };

  // Adding requires a real round trip first, since the database assigns
  // each event's real id — that's what later deletes/edits reference.
  const sendText = async () => {
    const parsed = parseText(draft, currentUser.id);
    if (!parsed || sending) return;
    setSending(true);
    setDraft("");
    try {
      const occurrencesForDb = parsed.occurrences.map((o) => ({
        ...o,
        title: parsed.title,
        time: parsed.time,
        endTime: parsed.endTime,
        member: parsed.member,
      }));
      const inserted = await dbInsertEvents(occurrencesForDb, currentUser.id);
      setEvents((e) => [...e, ...inserted]);
      const d = new Date(parsed.occurrences[0].date + "T12:00:00");
      setView({ y: d.getFullYear(), m: d.getMonth() });
      setSelected(parsed.occurrences[0].date);
      const who = memberById(members, parsed.member).name;
      const fmt = (k) => new Date(k + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const dateLabel = parsed.occurrences
        .map((o) => (o.endDate ? `${fmt(o.date)}–${fmt(o.endDate)}` : fmt(o.date)))
        .join(", ");
      const timeLabelStr = parsed.time ? (parsed.endTime ? `${parsed.time}–${parsed.endTime}` : parsed.time) : "";
      setToast({ msg: `Added: ${parsed.title} · ${dateLabel}${timeLabelStr ? " · " + timeLabelStr : ""} · ${who}` });
      setTimeout(() => setToast((t) => (t && !t.undoId ? null : t)), 3500);
    } catch (err) {
      console.error("Failed to add activity:", err);
      setToast({ msg: "Couldn't add that — check your connection and try again." });
      setTimeout(() => setToast(null), 4000);
    } finally {
      setSending(false);
    }
  };

  const handleGridSwipeStart = (e) => {
    gridSwipeX.current = e.touches[0].clientX;
    gridSwipeY.current = e.touches[0].clientY;
  };
  const handleGridSwipeEnd = (e) => {
    if (gridSwipeX.current === null) return;
    const dx = gridSwipeX.current - e.changedTouches[0].clientX;
    const dy = Math.abs(gridSwipeY.current - e.changedTouches[0].clientY);
    if (Math.abs(dx) > 60 && dy < 40) shift(dx > 0 ? 1 : -1);
    gridSwipeX.current = null;
    gridSwipeY.current = null;
  };

  const selectedEvents = selected ? byDate[selected] || [] : [];
  const selectedLabel = selected
    ? new Date(selected + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : "";

  return (
    <div style={{ fontFamily: "'Nunito', system-ui, sans-serif", background: "#FBF9F4", minHeight: "100vh", color: "#2B2B33" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Nunito:wght@400;600;700;800&display=swap');
        .fc-day { transition: transform .08s ease; }
        .fc-day:active { transform: scale(.93); }
        .fc-sheet { animation: fcUp .22s ease; }
        @keyframes fcUp { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .fc-grid-wrap { perspective: 1200px; }
        .fc-page-next { transform-origin: left center; animation: fcPageNext .32s ease-out; backface-visibility: hidden; }
        .fc-page-prev { transform-origin: right center; animation: fcPagePrev .32s ease-out; backface-visibility: hidden; }
        @keyframes fcPageNext { from { transform: rotateY(-32deg) scale(.97); opacity: .55; } to { transform: rotateY(0deg) scale(1); opacity: 1; } }
        @keyframes fcPagePrev { from { transform: rotateY(32deg) scale(.97); opacity: .55; } to { transform: rotateY(0deg) scale(1); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .fc-sheet { animation: none; } .fc-day { transition: none; } .fc-page-next, .fc-page-prev { animation: none; } }
        input, select { font-family: inherit; }
      `}</style>

      <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px 120px" }}>
        {/* Calendar title — tap to rename */}
        <div style={{ textAlign: "center", marginBottom: 4 }}>
          {editingTitle ? (
            <input
              autoFocus
              defaultValue={title}
              onBlur={(e) => saveTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveTitle(e.target.value)}
              maxLength={40}
              style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 20, textAlign: "center", border: "1px solid #ECE7DC", borderRadius: 12, padding: "6px 12px", background: "#fff", width: "85%", boxSizing: "border-box", color: "#2B2B33" }}
            />
          ) : (
            <button onClick={() => setEditingTitle(true)} title="Tap to rename"
              style={{ border: "none", background: "none", cursor: "pointer", fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 20, color: "#2B2B33", padding: "4px 8px" }}>
              {title} <span style={{ fontSize: 12, opacity: 0.3 }}>✎</span>
            </button>
          )}
        </div>
        <div style={{ textAlign: "center", fontSize: 11.5, opacity: 0.4, fontWeight: 700, marginBottom: 14 }}>
          <button onClick={() => setShowEditNames(true)}
            style={{ border: "none", background: "none", padding: 0, cursor: "pointer", color: "inherit", fontSize: "inherit", fontWeight: "inherit", textDecoration: "underline" }}>
            Edit names
          </button>
        </div>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <button onClick={() => shift(-1)} aria-label="Previous month" style={navBtn}>‹</button>
          <button onClick={() => { setPickerYear(view.y); setShowMonthPicker(true); }}
            style={{ border: "none", background: "none", cursor: "pointer", textAlign: "center", padding: "4px 12px", borderRadius: 12 }}>
            <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 30, lineHeight: 1.1 }}>{MONTHS[view.m]}</div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 2, opacity: 0.45 }}>{view.y} ▾</div>
          </button>
          <button onClick={() => shift(1)} aria-label="Next month" style={navBtn}>›</button>
        </div>

        {/* Filter chips — tap one or more people, or Everyone. Red badges show updates since your last visit. */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", margin: "14px 0 18px" }}>
          <span style={{ position: "relative" }}>
            <button onClick={() => setFilter([])}
              style={{ ...chip, background: filter.length === 0 ? "#2B2B33" : "#fff", color: filter.length === 0 ? "#fff" : "#2B2B33", borderColor: filter.length === 0 ? "#2B2B33" : "#ECE7DC" }}>
              Everyone
            </button>
            {updateCounts.total > 0 && <Badge count={updateCounts.total} />}
          </span>
          {members.map((m) => {
            const on = filter.includes(m.id);
            const count = updateCounts.byMember[m.id] || 0;
            return (
              <span key={m.id} style={{ position: "relative" }}>
                <button onClick={() => (count > 0 ? jumpToMemberUpdate(m.id) : toggleFilter(m.id))}
                  style={{ ...chip, background: on ? m.color : "#fff", color: on ? "#fff" : "#2B2B33", borderColor: on ? m.color : "#ECE7DC" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: on ? "#fff" : m.color }} />
                  {m.name}
                </button>
                {count > 0 && <Badge count={count} />}
              </span>
            );
          })}
          {deletedEvents.length > 0 && (
            <span style={{ position: "relative" }}>
              <button onClick={() => setShowTrash(true)}
                style={{ ...chip, background: "#fff", color: "#2B2B33", borderColor: "#ECE7DC", opacity: 0.7 }}>
                🗑 Deleted ({deletedEvents.length})
              </button>
              {updateCounts.trash > 0 && <Badge count={updateCounts.trash} />}
            </span>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 6 }}>
          {DOW.map((d, i) => (
            <div key={i} style={{ textAlign: "center", fontSize: 11, fontWeight: 800, opacity: 0.4 }}>{d}</div>
          ))}
        </div>

        {/* Grid — swipe left/right to change month, with a page-turn animation */}
        <div className="fc-grid-wrap">
          <div
            key={flipKey}
            onTouchStart={handleGridSwipeStart}
            onTouchEnd={handleGridSwipeEnd}
            className={flipDir === 1 ? "fc-page-next" : flipDir === -1 ? "fc-page-prev" : ""}
            style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}
          >
            {cells.map((d, i) => {
              if (d === null) return <div key={`e${i}`} />;
              const key = toKey(view.y, view.m, d);
              const evs = byDate[key] || [];
              const isToday = key === todayKey;
              const isSel = key === selected;
              return (
                <button
                  key={key}
                  className="fc-day"
                  onClick={() => setSelected(isSel ? null : key)}
                  style={{
                    aspectRatio: "1 / 1.15", border: isSel ? "2px solid #2B2B33" : "1px solid #ECE7DC",
                    borderRadius: 14, background: isToday ? "#FFF3D6" : "#fff", cursor: "pointer",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: 2,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: isToday ? 800 : 600 }}>{d}</span>
                  <span style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "center", minHeight: 7 }}>
                    {evs.slice(0, 4).map((ev) => (
                      <span key={ev.id} style={{ width: 7, height: 7, borderRadius: 99, background: memberById(members, ev.member).color }} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Day detail — inline panel on tablet/desktop, bottom sheet on phone */}
        {selected && isWide && (
          <div className="fc-sheet" style={{ marginTop: 18, background: "#fff", border: "1px solid #ECE7DC", borderRadius: 18, padding: "16px 18px 20px", boxShadow: "0 4px 16px rgba(43,43,51,.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 18 }}>{selectedLabel}</div>
              <button onClick={() => setSelected(null)} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, opacity: 0.4, padding: 4 }}>✕</button>
            </div>
            {selectedEvents.length === 0 && <div style={{ fontSize: 14, opacity: 0.5, padding: "8px 0" }}>Nothing planned for this day.</div>}
            {selectedEvents.map((ev) => <EventRow key={ev.id} ev={ev} members={members} onDelete={setConfirmDelete} onSwipeDelete={deleteEvent} />)}
          </div>
        )}

        {selected && !isWide && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(43,43,51,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 9 }}
            onClick={() => setSelected(null)}>
            <div className="fc-sheet" onClick={(e) => e.stopPropagation()}
              style={{ background: "#fff", borderRadius: "20px 20px 0 0", padding: "18px 18px 30px", width: "100%", maxWidth: 480, maxHeight: "70vh", overflowY: "auto", boxShadow: "0 -8px 24px rgba(43,43,51,.15)" }}>
              <div style={{ width: 36, height: 4, borderRadius: 99, background: "#ECE7DC", margin: "0 auto 14px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 18 }}>{selectedLabel}</div>
                <button onClick={() => setSelected(null)} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, opacity: 0.4, padding: 4 }}>✕</button>
              </div>
              {selectedEvents.length === 0 && <div style={{ fontSize: 14, opacity: 0.5, padding: "8px 0" }}>Nothing planned for this day.</div>}
              {selectedEvents.map((ev) => <EventRow key={ev.id} ev={ev} members={members} onDelete={setConfirmDelete} onSwipeDelete={deleteEvent} />)}
            </div>
          </div>
        )}

        {/* Month jump picker */}
        {showMonthPicker && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(43,43,51,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 15 }}
            onClick={() => setShowMonthPicker(false)}>
            <div className="fc-sheet" onClick={(e) => e.stopPropagation()}
              style={{ background: "#FBF9F4", borderRadius: "20px 20px 0 0", padding: "18px 18px 30px", width: "100%", maxWidth: 480 }}>
              <div style={{ width: 36, height: 4, borderRadius: 99, background: "#ECE7DC", margin: "0 auto 16px" }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <button onClick={() => setPickerYear((y) => y - 1)} style={navBtn}>‹</button>
                <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 22 }}>{pickerYear}</div>
                <button onClick={() => setPickerYear((y) => y + 1)} style={navBtn}>›</button>
              </div>

              {/* Quick jumps */}
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 16 }}>
                <button onClick={() => {
                  setView({ y: today.getFullYear(), m: today.getMonth() });
                  setPickerYear(today.getFullYear());
                  setShowMonthPicker(false);
                }} style={chip}>Today</button>
                <button onClick={() => {
                  const y = today.getFullYear() + 1;
                  setView({ y, m: today.getMonth() });
                  setPickerYear(y);
                  setSelected(null);
                }} style={chip}>{today.getFullYear() + 1}</button>
                <button onClick={() => {
                  const y = today.getFullYear() + 2;
                  setView({ y, m: today.getMonth() });
                  setPickerYear(y);
                  setSelected(null);
                }} style={chip}>{today.getFullYear() + 2}</button>
              </div>

              {/* Filter chips — change whose activities the counts below reflect */}
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <span style={{ position: "relative" }}>
                  <button onClick={() => setFilter([])}
                    style={{ ...chip, background: filter.length === 0 ? "#2B2B33" : "#fff", color: filter.length === 0 ? "#fff" : "#2B2B33", borderColor: filter.length === 0 ? "#2B2B33" : "#ECE7DC" }}>
                    Everyone
                  </button>
                  {updateCounts.total > 0 && <Badge count={updateCounts.total} />}
                </span>
                {members.map((m) => {
                  const on = filter.includes(m.id);
                  const count = updateCounts.byMember[m.id] || 0;
                  return (
                    <span key={m.id} style={{ position: "relative" }}>
                      <button onClick={() => (count > 0 ? jumpToMemberUpdate(m.id) : setFilter(on ? [] : [m.id]))}
                        style={{ ...chip, background: on ? m.color : "#fff", color: on ? "#fff" : "#2B2B33", borderColor: on ? m.color : "#ECE7DC" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: on ? "#fff" : m.color }} />
                        {m.name}
                      </button>
                      {count > 0 && <Badge count={count} />}
                    </span>
                  );
                })}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {MONTHS.map((mn, i) => {
                  const isCurrent = i === view.m && pickerYear === view.y;
                  const count = countsByMonth[`${pickerYear}-${String(i + 1).padStart(2, "0")}`] || 0;
                  return (
                    <button key={i}
                      onClick={() => { setView({ y: pickerYear, m: i }); setShowMonthPicker(false); }}
                      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, borderRadius: 12, border: isCurrent ? "2px solid #2B2B33" : "1px solid #ECE7DC", background: isCurrent ? "#2B2B33" : "#fff", color: isCurrent ? "#fff" : "#2B2B33", padding: "10px 0 8px", fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>
                      <span>{mn.slice(0, 3)}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 700, opacity: 0.55 }}>{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Text bar — adds activities to the shared calendar */}
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "#FBF9F4", borderTop: "1px solid #ECE7DC", padding: "10px 14px 16px" }}>
          <div style={{ maxWidth: 480, margin: "0 auto" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendText()}
                placeholder='e.g. "Soccer 9am" — date defaults to today'
                disabled={sending}
                style={{ flex: 1, border: "1px solid #ECE7DC", borderRadius: 999, padding: "11px 16px", fontSize: 15, background: "#fff", boxSizing: "border-box" }}
              />
              <button onClick={sendText} disabled={sending} aria-label="Add activity"
                style={{ width: 44, height: 44, borderRadius: 99, border: "none", background: draft.trim() && !sending ? "#4A7CFA" : "#C9C4B8", color: "#fff", fontSize: 18, cursor: sending ? "default" : "pointer", flexShrink: 0 }}>
                {sending ? "…" : "↑"}
              </button>
            </div>
          </div>
        </div>

        {/* Recently deleted sheet */}
        {showTrash && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(43,43,51,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 10 }}
            onClick={() => setShowTrash(false)}>
            <div className="fc-sheet" onClick={(e) => e.stopPropagation()}
              style={{ background: "#fff", borderRadius: "20px 20px 0 0", padding: "18px 18px 30px", width: "100%", maxWidth: 480, maxHeight: "70vh", overflowY: "auto", boxShadow: "0 -8px 24px rgba(43,43,51,.15)" }}>
              <div style={{ width: 36, height: 4, borderRadius: 99, background: "#ECE7DC", margin: "0 auto 14px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 18 }}>Recently deleted</div>
                <button onClick={() => setShowTrash(false)} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, opacity: 0.4, padding: 4 }}>✕</button>
              </div>
              <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 10 }}>
                Deleted activities are kept for 30 days, then removed for good.
              </div>
              {deletedEvents.length === 0 && (
                <div style={{ fontSize: 14, opacity: 0.5, padding: "8px 0" }}>Nothing here.</div>
              )}
              {deletedEvents.map((ev) => {
                const m = memberById(members, ev.member);
                const evDate = new Date(ev.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
                const deletedByMember = ev.deletedBy ? memberById(members, ev.deletedBy) : null;
                return (
                  <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid #F3EFE6" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 99, background: m.color, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{ev.title}</div>
                      <div style={{ fontSize: 12, opacity: 0.55 }}>
                        {[ev.endDate ? rangeLabel(ev) : evDate, timeLabel(ev), m.name].filter(Boolean).join(" · ")}
                      </div>
                      <div style={{ fontSize: 10.5, opacity: 0.35, marginTop: 2 }}>
                        Deleted{deletedByMember ? ` by ${deletedByMember.name}` : ""} · {new Date(ev.deletedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} at {new Date(ev.deletedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </div>
                    </div>
                    <button onClick={() => restoreEvent(ev.id)}
                      style={{ ...chip, borderColor: "#2B2B33", fontWeight: 800 }}>
                      Restore
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Edit family names sheet */}
        {showEditNames && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(43,43,51,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 14 }}
            onClick={() => setShowEditNames(false)}>
            <div className="fc-sheet" onClick={(e) => e.stopPropagation()}
              style={{ background: "#fff", borderRadius: "20px 20px 0 0", padding: "18px 18px 30px", width: "100%", maxWidth: 480, maxHeight: "75vh", overflowY: "auto", boxShadow: "0 -8px 24px rgba(43,43,51,.15)" }}>
              <div style={{ width: 36, height: 4, borderRadius: 99, background: "#ECE7DC", margin: "0 auto 14px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 18 }}>Edit family names</div>
                <button onClick={() => setShowEditNames(false)} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, opacity: 0.4, padding: 4 }}>✕</button>
              </div>
              <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 14 }}>
                Changes save automatically and show up for everyone right away.
              </div>
              {members.map((m) => (
                <div key={m.id} style={{ padding: "14px 0", borderTop: "1px solid #F3EFE6" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 99, background: m.color, flexShrink: 0 }} />
                    <input
                      defaultValue={m.name}
                      onBlur={(e) => saveMemberName(m.id, e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
                      maxLength={24}
                      style={{ flex: 1, border: "1px solid #ECE7DC", borderRadius: 10, padding: "8px 12px", fontSize: 15, fontWeight: 700, background: "#fff", boxSizing: "border-box" }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 7, paddingLeft: 22 }}>
                    {COLOR_OPTIONS.map((c) => (
                      <button key={c} onClick={() => saveMemberColor(m.id, c)} aria-label={`Set color ${c}`}
                        style={{ width: 22, height: 22, borderRadius: 99, background: c, border: m.color === c ? "2px solid #2B2B33" : "2px solid transparent", cursor: "pointer", padding: 0 }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Delete confirmation dialog */}
        {confirmDelete && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(43,43,51,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 12, padding: 24 }}
            onClick={() => setConfirmDelete(null)}>
            <div className="fc-sheet" onClick={(e) => e.stopPropagation()}
              style={{ background: "#fff", borderRadius: 18, padding: "20px 18px", width: "100%", maxWidth: 340, boxShadow: "0 12px 32px rgba(43,43,51,.25)" }}>
              <div style={{ fontFamily: "'Fredoka', sans-serif", fontWeight: 600, fontSize: 17, marginBottom: 6 }}>
                Delete this activity?
              </div>
              <div style={{ fontSize: 14, opacity: 0.65, marginBottom: 16 }}>
                "{confirmDelete.title}"
                {confirmDelete.endDate
                  ? ` will be removed from all days (${rangeLabel(confirmDelete)}).`
                  : " will be removed from the calendar."}
                {" "}You can restore it from Recently deleted for 30 days.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setConfirmDelete(null)}
                  style={{ flex: 1, borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 800, cursor: "pointer", background: "#fff", color: "#2B2B33", border: "1px solid #ECE7DC" }}>
                  Cancel
                </button>
                <button onClick={() => { deleteEvent(confirmDelete.id); setConfirmDelete(null); }}
                  style={{ flex: 1, borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 800, cursor: "pointer", background: "#D64541", color: "#fff", border: "none" }}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast confirming actions, with Undo for deletions */}
        {toast && (
          <div className="fc-sheet" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 96, background: "#2B2B33", color: "#fff", borderRadius: 14, padding: "10px 16px", fontSize: 13, fontWeight: 700, maxWidth: "88%", zIndex: 13, boxShadow: "0 6px 18px rgba(43,43,51,.3)", display: "flex", alignItems: "center", gap: 12 }}>
            <span>{toast.msg}</span>
            {toast.undoId && (
              <button onClick={() => restoreEvent(toast.undoId)}
                style={{ border: "none", background: "none", color: "#FFD66B", fontWeight: 800, fontSize: 13, cursor: "pointer", padding: 0 }}>
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const navBtn = { width: 40, height: 40, borderRadius: 12, border: "1px solid #ECE7DC", background: "#fff", fontSize: 22, cursor: "pointer", lineHeight: 1 };
const chip = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, border: "1px solid #ECE7DC", borderRadius: 999, padding: "6px 12px", cursor: "pointer" };
