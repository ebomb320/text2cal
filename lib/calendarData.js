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

// ---- family members ----

export async function getMembers() {
  const { data, error } = await supabase
    .from("family_members")
    .select("id, name, color, role")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function getMemberByToken(token) {
  const { data, error } = await supabase
    .from("family_members")
    .select("id, name, color, role")
    .eq("link_token", token)
    .maybeSingle();
  if (error) throw error;
  return data; // null if no match — caller shows a "link not recognized" message
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
    source: "web",
    created_by: createdBy,
  }));
  const { data, error } = await supabase.from("events").insert(rows).select("*");
  if (error) throw error;
  return data.map(rowToEvent);
}

export async function softDeleteEvent(id, deletedBy) {
  const { error } = await supabase
    .from("events")
    .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
    .eq("id", id);
  if (error) throw error;
}

export async function restoreEvent(id) {
  const { error } = await supabase
    .from("events")
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", id);
  if (error) throw error;
}

// Permanently removes anything soft-deleted more than 30 days ago.
// Safe to call on every page load — it's a no-op when nothing qualifies.
export async function purgeOldDeleted() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await supabase.from("events").delete().lt("deleted_at", cutoff);
}
