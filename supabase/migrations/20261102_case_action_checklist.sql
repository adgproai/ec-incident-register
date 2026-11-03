-- Applied to Supabase project TravelLife on 2 Nov 2026 (migration case_action_checklist).
-- Remedial and close-out checklist per case. Items are defined per category in index.html (ACTIONS),
-- generated from Remedial_actions.xlsx (Actions list sheet). Ticks are stored by position:
-- {"R1": {"at": "<iso>", "by": "<staff name>", "text": "<wording when ticked>"}, "C2": {...}}
alter table public.cases add column if not exists checklist jsonb not null default '{}'::jsonb;
alter table public.cases add constraint cases_checklist_is_object check (jsonb_typeof(checklist) = 'object');
