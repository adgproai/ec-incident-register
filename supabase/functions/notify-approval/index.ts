// Experiences Caribbean · Incident & Feedback Register
// Edge Function: notify-approval
//
// Called by the database (trigger cases_after_update_approval) when a case is
//  - submitted for approval  -> emails every active approver (except the person who submitted it)
//  - sent back by an approver -> emails the person who submitted it and the case owner (if the owner is a team member)
// Safety: the function does not trust the caller. It acts only on a pending event the database itself
// stored on the case (cases.approval_notify), claims it once, and writes the result to the case log.
// Confidential cases: the email gives the reference only, never the topic or details.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_URL = "https://reports.experiencescaribbean.com/";
const DEFAULT_FROM = "EC Reports <reports@experiencescaribbean.com>";
const CATEGORY: Record<string, string> = {
  complaint: "Complaint", compliment: "Compliment or suggestion", injury: "Accident, injury or illness",
  nearmiss: "Near miss or safety hazard", emergency: "Emergency", supplier: "Supplier, wildlife or environment",
  safeguarding: "Child protection or exploitation", grievance: "Staff grievance", ethics: "Ethics or whistleblowing",
};
const EMAIL_RE = /^[^\s<>@,]+@[^\s<>@,]+\.[a-z]{2,}$/i;
const env = (k: string) => (Deno.env.get(k) || "").trim();
const clean = (v: string) => v.replace(/^[\s`'"]+|[\s`'"]+$/g, "").replace(/[`]/g, "").trim();
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  let caseId = "";
  try { caseId = String((await req.json()).case_id || ""); } catch { /* ignore */ }
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) return json(400, { error: "case_id required" });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  const { data: rows, error } = await db.from("cases")
    .select("id, ref, category, severity, status, restricted, title, owner, root_cause, action, log, approval_notify, approval_requested_by, approval_requested_by_name")
    .eq("id", caseId).limit(1);
  if (error) return json(500, { error: error.message });
  const c = rows?.[0];
  const ev = c?.approval_notify as { type?: string; at?: string; by?: string } | null;
  if (!c || !ev || !ev.type) return json(200, { skipped: "nothing pending" });

  // claim the event once (a second call finds nothing to do)
  const { data: claimed } = await db.from("cases").update({ approval_notify: null })
    .eq("id", c.id).eq("approval_notify->>at", String(ev.at)).select("id");
  if (!claimed || !claimed.length) return json(200, { skipped: "already handled" });

  const { data: team } = await db.from("staff_invites").select("email, full_name, roles, active").eq("active", true);
  const members = (team || []) as { email: string; full_name: string; roles: string[] }[];
  let submitterEmail = "";
  if (c.approval_requested_by) {
    const { data: s } = await db.from("staff").select("email").eq("user_id", c.approval_requested_by).limit(1);
    submitterEmail = String(s?.[0]?.email || "").toLowerCase();
  }

  const byName = String(ev.by || "").trim();
  const link = `${SITE_URL}?case=${encodeURIComponent(c.ref)}#register`;
  const cat = CATEGORY[c.category] || c.category;
  const lines = c.restricted
    ? `<p>This is a <strong>confidential</strong> case. Sign in to the register to see it.</p>`
    : `<table style="border-collapse:collapse;margin:8px 0 14px">
        <tr><td style="padding:3px 12px 3px 0;color:#6b645c">Reference</td><td><strong>${esc(c.ref)}</strong></td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#6b645c">Category</td><td>${esc(cat)} · ${esc(c.severity)}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#6b645c">Summary</td><td>${esc(c.title)}</td></tr>
        ${c.owner ? `<tr><td style="padding:3px 12px 3px 0;color:#6b645c">Case owner</td><td>${esc(c.owner)}</td></tr>` : ""}
        <tr><td style="padding:3px 12px 3px 0;color:#6b645c;vertical-align:top">Root cause</td><td>${esc(c.root_cause)}</td></tr>
        <tr><td style="padding:3px 12px 3px 0;color:#6b645c;vertical-align:top">Corrective action</td><td style="white-space:pre-wrap">${esc(c.action)}</td></tr>
      </table>`;

  let to: string[] = [], subject = "", heading = "", body = "", logNote = "";
  if (ev.type === "submitted") {
    to = members.filter((m) => (m.roles || []).includes("approver") && m.email.toLowerCase() !== submitterEmail).map((m) => m.email);
    if (!to.length) to = members.filter((m) => (m.roles || []).includes("approver")).map((m) => m.email);
    subject = `Case ${c.ref} is ready for your approval`;
    heading = "A case is ready for your approval";
    body = `<p>${esc(byName || "A team member")} has submitted this case for approval.</p>${lines}
      <p>Open the case, check the root cause, the corrective action and the checklist, then tap <strong>Approve and close</strong>, or <strong>Send back</strong> with a reason.</p>`;
    logNote = "Approval request emailed to ";
  } else if (ev.type === "sent_back") {
    const ownerKey = String(c.owner || "").trim().toLowerCase();
    const owner = ownerKey ? members.find((m) => m.full_name?.trim().toLowerCase() === ownerKey || m.email.toLowerCase() === ownerKey) : undefined;
    to = [submitterEmail, owner?.email || ""].filter(Boolean);
    // the reason is the latest "Sent back by the approver" note in the case log
    const log = Array.isArray(c.log) ? c.log as { note?: string }[] : [];
    const note = [...log].reverse().find((l) => /^Sent back by the approver:/i.test(String(l.note || "")));
    const reason = note ? String(note.note).replace(/^Sent back by the approver:\s*/i, "") : "";
    subject = `Case ${c.ref} was sent back by the approver`;
    heading = "A case was sent back";
    body = `<p>${esc(byName || "The approver")} did not approve this case yet and has sent it back to <em>Action in progress</em>.</p>
      ${reason ? `<p><strong>What still needs doing:</strong></p><p style="white-space:pre-wrap;border-left:3px solid #ff8000;padding-left:10px">${esc(c.restricted ? "See the case log in the register." : reason)}</p>` : ""}
      ${lines}<p>When it is done, tap <strong>Submit for approval</strong> again.</p>`;
    logNote = "Sent-back notice emailed to ";
  } else return json(200, { skipped: "unknown event" });

  to = [...new Set(to.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  let result = "";
  const resendKey = clean(env("RESEND_API_KEY"));
  const fromRaw = clean(env("NOTIFY_EMAIL_FROM"));
  const emailFrom = /^([^<>]+<)?[^\s<>@]+@experiencescaribbean\.com>?$/i.test(fromRaw) ? fromRaw : DEFAULT_FROM;
  if (!to.length) result = ev.type === "submitted" ? "Approval request not emailed: no approver is assigned" : "Sent-back notice not emailed: no team member to notify (owner not matched to a team member)";
  else if (!resendKey) result = "Approval email not sent: email is not set up";
  else {
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:600px">
      <h2 style="margin:0 0 8px">${esc(heading)}</h2>${body}
      <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:3px;text-decoration:none">Open case ${esc(c.ref)}</a></p>
      <p style="font-size:12px;color:#6b645c">Sent automatically by the Experiences Caribbean incident &amp; feedback register.</p></div>`;
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: emailFrom, to, subject: c.restricted ? `Case ${c.ref}: ${ev.type === "submitted" ? "ready for your approval" : "sent back by the approver"}` : subject, html }),
      });
      result = r.ok ? logNote + to.join(", ") : `Approval email failed (${r.status}): ${(await r.text()).slice(0, 200)}`;
    } catch (e) { result = `Approval email failed: ${String(e).slice(0, 200)}`; }
  }

  const { data: fresh } = await db.from("cases").select("log").eq("id", c.id).limit(1);
  const log = Array.isArray(fresh?.[0]?.log) ? fresh![0].log : [];
  await db.from("cases").update({ log: log.concat([{ at: new Date().toISOString(), note: result, by: "Alerts" }]) }).eq("id", c.id);
  return json(200, { result });
});
