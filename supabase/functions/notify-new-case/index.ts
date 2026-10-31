// Experiences Caribbean · Incident & Feedback Register
// Edge Function: notify-new-case
//
// Called by the database (pg_net trigger) once for every new case.
// - Email to TEAM_EMAIL (the shared team inbox) for every new case (via Resend), with the report's photos attached
//   (not for confidential cases, whose photos stay in the register).
// - WhatsApp to NOTIFY_WHATSAPP_TO for urgent cases only (Meta WhatsApp Cloud API, approved template).
//   Urgent = severity High or Critical, or category injury, emergency or safeguarding.
// - Restricted cases (safeguarding, grievance, ethics) never carry details in email or WhatsApp.
// - The result is written to the case log, so the register shows who was alerted.
//
// Safety: the function does not trust the caller. It only acts on a case that exists,
// was received in the last 15 minutes and has not been alerted yet (notified_at is null),
// so calling it again or with a made-up id sends nothing.
//
// Secrets (Supabase → Edge Functions → Secrets). A channel whose secrets are missing is skipped.
//   RESEND_API_KEY, NOTIFY_EMAIL_FROM (e.g. "EC Reports <reports@experiencescaribbean.com>")
//   WHATSAPP_TOKEN (permanent System User token), WHATSAPP_PHONE_NUMBER_ID, NOTIFY_WHATSAPP_TO (e.g. 17676165827)
//   optional: WHATSAPP_TEMPLATE (default urgent_incident_alert), WHATSAPP_TEMPLATE_LANG (default en),
//             WHATSAPP_API_VERSION (default v22.0). Template "hello_world" (en_US) works for a first test.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// The team inbox is set in code below (TEAM_EMAIL), not as a secret: it is not confidential,
// and keeping it here means it is versioned with the rest of the app.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// Shared inbox that the staff monitor. For more than one address, separate them with commas.
const TEAM_EMAIL = "adventure@experiencescaribbean.com";

const REGISTER_URL = "https://reports.experiencescaribbean.com/#register";
const CATEGORY: Record<string, string> = {
  complaint: "Complaint", compliment: "Compliment or suggestion", injury: "Accident, injury or illness",
  nearmiss: "Near miss or safety hazard", emergency: "Emergency", supplier: "Supplier, wildlife or environment",
  safeguarding: "Child protection or exploitation", grievance: "Staff grievance", ethics: "Ethics or whistleblowing",
};
const URGENT_CATEGORIES = ["injury", "emergency", "safeguarding"];

const env = (k: string) => (Deno.env.get(k) || "").trim();
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let caseId = "";
  try { caseId = String((await req.json()).case_id || ""); } catch { /* ignore */ }
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) return json(400, { error: "case_id required" });

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  // Claim the case: only a fresh case that has not been alerted yet.
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: claimed, error: claimErr } = await db.from("cases")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", caseId).is("notified_at", null).gte("received_at", since)
    .select("id, ref, category, severity, status, reporter_type, channel, anonymous, restricted, title, description, place, tour, occurred_at, received_at, extras, log");
  if (claimErr) return json(500, { error: claimErr.message });
  if (!claimed || !claimed.length) return json(200, { skipped: "unknown, old or already alerted" });
  const c = claimed[0];

  const urgent = c.severity === "High" || c.severity === "Critical" || URGENT_CATEGORIES.includes(c.category);
  const cat = CATEGORY[c.category] || c.category;
  const results: string[] = [];
  const { data: photoRows } = await db.from("case_photos").select("path").eq("case_id", c.id).order("path");
  const nPhotos = (photoRows || []).length;
  // Photos travel with the email for ordinary cases. Confidential cases keep them in the register only.
  const attachments: { filename: string; content: string }[] = [];
  if (!c.restricted) {
    for (const [i, r] of (photoRows || []).entries()) {
      const { data: file } = await db.storage.from("case-photos").download(r.path);
      if (file) attachments.push({ filename: `${c.ref}-photo-${i + 1}.${r.path.split(".").pop()}`, content: encodeBase64(new Uint8Array(await file.arrayBuffer())) });
    }
  }

  // ---------- email (every case) ----------
  // Secrets are often pasted with stray quotes or backticks; clean them, and fall back to safe defaults.
  const clean = (v: string) => v.replace(/^[\s`'"]+|[\s`'"]+$/g, "").replace(/[`]/g, "").trim();
  const DEFAULT_FROM = "EC Reports <reports@experiencescaribbean.com>";
  const fromRaw = clean(env("NOTIFY_EMAIL_FROM"));
  const emailFrom = /^([^<>]+<)?[^\s<>@]+@experiencescaribbean\.com>?$/i.test(fromRaw) ? fromRaw : DEFAULT_FROM;
  const emailTo = TEAM_EMAIL;
  const resendKey = clean(env("RESEND_API_KEY"));
  if (emailTo && emailFrom && resendKey) {
    const subject = (urgent ? "URGENT: " : "") + (c.restricted
      ? `New confidential report ${c.ref}`
      : `New report ${c.ref} · ${cat} · ${c.severity}`);
    const row = (k: string, v: unknown) => v ? `<tr><td style="padding:4px 12px 4px 0;color:#6b645c;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>` : "";
    const when = (v: string | null) => v ? new Date(v).toLocaleString("en-GB", { timeZone: "America/Dominica", dateStyle: "medium", timeStyle: "short" }) : "";
    const x = (c.extras || {}) as Record<string, unknown>;
    const yn = (v: unknown) => typeof v === "boolean" ? (v ? "Yes" : "No") : "";
    const details = c.restricted
      ? `<p>This is a <strong>confidential</strong> report (${esc(cat)}). Its details are visible only to its designated handler. Sign in to the register to see it.</p>`
      : `<table style="border-collapse:collapse;font-size:14px">
           ${row("Reference", c.ref)}${row("Category", cat)}${row("Severity", c.severity)}
           ${row("Reported by", (c.anonymous ? "Anonymous " : "") + (c.reporter_type === "staff" ? "staff / guide" : "guest") + " · " + c.channel)}
           ${row("Happened", when(c.occurred_at))}${row("Where", c.place)}${row("Tour", c.tour)}
           ${row("Summary", c.title)}
           ${row("People involved", x.persons)}${row("Injury or illness", x.injury)}
           ${row("First aid given", yn(x.firstaid))}${row("Taken to clinic or hospital", yn(x.hospital))}
           ${row("Police or authorities told", yn(x.authorities))}${row("Insurer told", yn(x.insurer))}${row("Witnesses", x.witness)}
           ${row("Supplier", x.supplier)}${row("Supplier type", x.stype)}
           ${row("Photos", nPhotos ? (attachments.length === nPhotos ? `${nPhotos} attached to this email` : `${nPhotos} (open the case in the register to see them)`) : "")}
           ${row("Received", when(c.received_at))}
         </table>
         <p style="white-space:pre-wrap;border-left:3px solid #ff8000;padding-left:10px">${esc(c.description)}</p>`;
    const html = `<div style="font-family:Arial,sans-serif;color:#2b2723;max-width:600px">
        <h2 style="margin:0 0 8px">${urgent ? "Urgent: " : ""}a new report has been received</h2>
        ${details}
        <p><a href="${REGISTER_URL}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:3px;text-decoration:none">Open the case register</a></p>
        <p style="font-size:12px;color:#6b645c">Contact details, if any, are in the register, not in this email. Sent automatically by the Experiences Caribbean incident &amp; feedback register.</p>
      </div>`;
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: emailFrom, to: emailTo.split(",").map((s) => s.trim()).filter(Boolean), subject, html, ...(attachments.length ? { attachments } : {}) }),
      });
      results.push(r.ok ? `Alert emailed to ${emailTo}${attachments.length ? ` with ${attachments.length} photo${attachments.length > 1 ? "s" : ""}` : ""}` : `Alert email failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    } catch (e) { results.push(`Alert email failed: ${String(e).slice(0, 200)}`); }
  } else {
    results.push("Alert email not sent: email is not set up yet");
  }

  // ---------- WhatsApp (urgent cases only) ----------
  // Business-initiated WhatsApp messages must use a template approved by Meta.
  // Template urgent_incident_alert (Utility, English) has one variable: {{1}} = case reference.
  if (urgent) {
    const token = clean(env("WHATSAPP_TOKEN")), phoneId = clean(env("WHATSAPP_PHONE_NUMBER_ID")).replace(/\D/g, "");
    const to = clean(env("NOTIFY_WHATSAPP_TO")).replace(/\D/g, "");
    const template = clean(env("WHATSAPP_TEMPLATE")) || "urgent_incident_alert";
    const lang = clean(env("WHATSAPP_TEMPLATE_LANG")) || (template === "hello_world" ? "en_US" : "en");
    const ver = clean(env("WHATSAPP_API_VERSION")) || "v22.0";
    if (token && phoneId && to) {
      const tpl: Record<string, unknown> = { name: template, language: { code: lang } };
      if (template !== "hello_world") tpl.components = [{ type: "body", parameters: [{ type: "text", text: c.ref }] }];
      try {
        const r = await fetch(`https://graph.facebook.com/${ver}/${phoneId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: tpl }),
        });
        results.push(r.ok ? `Urgent WhatsApp sent to +${to}` : `Urgent WhatsApp failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
      } catch (e) { results.push(`Urgent WhatsApp failed: ${String(e).slice(0, 200)}`); }
    } else {
      results.push("Urgent WhatsApp not sent: WhatsApp is not set up yet");
    }
  }

  // ---------- record what happened in the case log ----------
  const now = new Date().toISOString();
  const log = Array.isArray(c.log) ? c.log : [];
  await db.from("cases").update({ log: log.concat(results.map((note) => ({ at: now, note, by: "Alerts" }))) }).eq("id", c.id);

  return json(200, { ref: c.ref, urgent, results });
});
