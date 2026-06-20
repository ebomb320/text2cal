import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Surfaces a clear error instead of a confusing runtime crash if the
  // environment variables weren't set in Vercel (or .env.local locally).
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
    "Set these in Vercel → Project → Settings → Environment Variables."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
