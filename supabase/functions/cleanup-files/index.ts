// Experiences Caribbean · Incident & Feedback Register
// Edge Function: cleanup-files
//
// Removes stored files that no report or case refers to any more ("orphans"):
//  - case-photos: photos uploaded on the form but never sent, or whose report was deleted
//  - case-files:  staff documents whose record was deleted
// Safety: a file is removed only if NO row in case_photos / case_files points to it AND it is
// older than 6 hours (so a guest's photo that is mid-upload is never touched). Files that belong
// to a case are never removed. It can be called again at any time; it just finds nothing to do.
// Call it from the database:  select net.http_post(url := '<project>/functions/v1/cleanup-files', body := '{}'::jsonb);

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MIN_AGE_MS = 6 * 60 * 60 * 1000;
const BUCKETS: [string, string][] = [["case-photos", "case_photos"], ["case-files", "case_files"]];
const env = (k: string) => (Deno.env.get(k) || "").trim();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  async function listAll(bucket: string, prefix = "", depth = 0): Promise<{ path: string; created: string }[]> {
    const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new Error(`${bucket}: ${error.message}`);
    let files: { path: string; created: string }[] = [];
    for (const e of data || []) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) { if (depth < 4) files = files.concat(await listAll(bucket, p, depth + 1)); }
      else files.push({ path: p, created: e.created_at as string });
    }
    return files;
  }

  const report: Record<string, unknown> = {};
  try {
    for (const [bucket, table] of BUCKETS) {
      const { data: refs, error } = await db.from(table).select("path");
      if (error) throw new Error(`${table}: ${error.message}`);
      const keep = new Set((refs || []).map((r: { path: string }) => r.path));
      const all = await listAll(bucket);
      const cutoff = Date.now() - MIN_AGE_MS;
      const orphans = all.filter((f) => !keep.has(f.path) && Date.parse(f.created) < cutoff).map((f) => f.path);
      const removed: string[] = [];
      for (let i = 0; i < orphans.length; i += 100) {
        const chunk = orphans.slice(i, i + 100);
        const { error: rmErr } = await db.storage.from(bucket).remove(chunk);
        if (rmErr) throw new Error(`${bucket} remove: ${rmErr.message}`);
        removed.push(...chunk);
      }
      report[bucket] = { stored: all.length, in_use: keep.size, removed: removed.length };
    }
  } catch (e) {
    return json(500, { error: String(e).slice(0, 300), report });
  }
  return json(200, report);
});
