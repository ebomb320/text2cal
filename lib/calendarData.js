import { supabase } from "./supabaseClient";

// ---- mapping helpers: DB snake_case <-> UI camelCase ----

function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    endDate: row.end_date || null,
    time: row.time || "",
    endTime: row.end_time || "",
    member: row.member,
    source: row.source,
    createdAt: row.created_at,
    createdBy: row.created_by,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

// Pushes live updates the instant another device adds/edits/deletes
// something — requires Realtime to be enabled on these three tables in
// Supabase (see the accompanying SQL snippet). Returns an unsubscribe fn.
export function subscribeToChanges(onEventsChange, onMembersChange, onSettingsChange) {
  const channel = supabase
    .channel("calendar-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, onEventsChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "family_members" }, onMembersChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "calendar_settings" }, onSettingsChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ---- family members ----

export async function getMembers() {
  const { data, error } = await supabase
    .from("family_members")
    .select("id, name, color, role, archived")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function getMemberByToken(token) {
  const { data, error } = await supabase
    .from("family_members")
    .select("id, name, color, role, archived")
    .eq("link_token", token)
    .maybeSingle();
  if (error) throw error;
  return data; // null if no match — caller shows a "link not recognized" message
}

// Looks up one member's link on demand (e.g. an admin tapping "Link" for
// someone already in the family). Deliberately separate from getMembers()
// so tokens aren't included in the data every visitor fetches by default.
export async function getMemberLink(id) {
  const { data, error } = await supabase
    .from("family_members")
    .select("link_token")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data.link_token;
}

// Adds a new family member with an auto-generated private link.
// Returns the new row, including link_token, so the caller can show/share it.
export async function addMember(id, name, color) {
  const { data, error } = await supabase
    .from("family_members")
    .insert({ id, name, color })
    .select("id, name, color, role, archived, link_token")
    .single();
  if (error) throw error;
  return data;
}

// "Removing" someone archives them rather than deleting the row — their
// past activities stay correctly attributed, and they can be restored.
// Archiving also deactivates their personal link (checked in app/c/[token]).
export async function setMemberArchived(id, archived) {
  const { error } = await supabase.from("family_members").update({ archived }).eq("id", id);
  if (error) throw error;
}

export async function updateMember(id, { name, color }) {
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (color !== undefined) patch.color = color;
  const { error } = await supabase.from("family_members").update(patch).eq("id", id);
  if (error) throw error;
}

// ---- calendar settings (title) ----

export async function getSettings() {
  const { data, error } = await supabase
    .from("calendar_settings")
    .select("title")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return data ? data.title : "Family Calendar";
}

export async function updateSettingsTitle(title) {
  const { error } = await supabase
    .from("calendar_settings")
    .update({ title })
    .eq("id", 1);
  if (error) throw error;
}

// ---- events ----

// Fetches all events except those soft-deleted more than 30 days ago,
// mirroring the "Recently deleted, kept for 30 days" behavior in the UI.
export async function getEvents() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .or(`deleted_at.is.null,deleted_at.gt.${cutoff}`)
    .order("date", { ascending: true });
  if (error) throw error;
  return data.map(rowToEvent);
}

// occurrences: [{ title, date, endDate, time, endTime, member }]
// createdBy: the id of the family member whose link sent this text
export async function insertEvents(occurrences, createdBy) {
  const rows = occurrences.map((o) => ({
    title: o.title,
    date: o.date,
    end_date: o.endDate || null,
    time: o.time || null,
    end_time: o.endTime || null,
    member: o.member,
    source: "web"
