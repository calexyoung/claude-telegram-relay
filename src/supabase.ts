/**
 * Supabase Client Module
 *
 * Lazy-initialized singleton. Returns null when credentials are missing
 * so the bot degrades gracefully without a database.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key || url.includes("your_") || key.includes("your_")) {
    return null;
  }

  client = createClient(url, key);
  return client;
}
