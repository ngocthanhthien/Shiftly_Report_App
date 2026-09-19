-- Shiftly Report — Supabase (Postgres) backend
-- Run in the Supabase Dashboard → SQL Editor → New query → paste this whole
-- file → Run. Safe to re-run any time (every statement is idempotent).
--
-- Design: every real table is locked down (RLS enabled, no policies), and
-- the ONLY way in is through the sync_* functions below (SECURITY DEFINER,
-- so they run with the owner's privileges and bypass RLS regardless of who
-- calls them). Each one checks the CALLER's real identity — a Supabase Auth
-- session (`auth.uid()`), verified against the `members` table — instead of
-- a shared password. See supabase/README.md for how to create the first
-- Admin account and deploy the admin-users Edge Function that manages the
-- rest.
--
-- The sync cursor (`seq`) is a Postgres SEQUENCE, assigned per row on every
-- write — always increasing, never based on any device's clock (a phone or
-- PC with the wrong time must never cause another device to silently miss
-- data — see index.html's cloud-sync comments for the history of that bug).

create table if not exists checkpoints (
  key text primary key,
  date text not null,
  shift text not null,
  section text not null,
  po text not null default '',
  recipe text not null default '',
  client text not null default '',
  technician text not null default '',
  fields jsonb not null default '{}',
  field_notes jsonb not null default '{}',
  images jsonb not null default '[]',
  updated_at text not null,
  deleted boolean not null default false,
  seq bigint not null default 0
);
create sequence if not exists checkpoints_seq;
create index if not exists idx_checkpoints_seq on checkpoints (seq);
create index if not exists idx_checkpoints_date_shift on checkpoints (date, shift);
create index if not exists idx_checkpoints_po on checkpoints (po);

create table if not exists meta (
  k text primary key,
  value jsonb not null,
  updated_at text not null
);

create table if not exists logs (
  id bigserial primary key,
  ts text not null,
  date text,
  shift text,
  po text,
  section text,
  technician text,
  changes jsonb not null default '[]'
);
create index if not exists idx_logs_ts on logs (ts);

alter table checkpoints enable row level security;
alter table meta enable row level security;
alter table logs enable row level security;
-- No policies are created for any of them — RLS with zero policies denies
-- all direct REST access (anon/authenticated), which is exactly the point.

-- ===================== Access control (members) =====================
-- Real Supabase Auth accounts: Admin signs in with a real email + password;
-- User signs in with a username + password (Supabase Auth only knows
-- email/phone, so a username account is given a synthetic, never-mailed
-- address — see the admin-users Edge Function for the exact transform).
-- Either way, the row here is what grants (or revokes) access to this app —
-- having a Supabase Auth account alone grants nothing.

create table if not exists members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  username text,
  role text not null default 'user' check (role in ('admin', 'user', 'supervisor')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_members_username on members (lower(username)) where username is not null;
-- Migration for a project created before the 'supervisor' role existed:
-- `create table if not exists` above doesn't touch an already-existing
-- table's CHECK constraint, so widen it explicitly (safe/idempotent).
alter table members drop constraint if exists members_role_check;
alter table members add constraint members_role_check check (role in ('admin', 'user', 'supervisor'));

create table if not exists member_audit (
  id bigserial primary key,
  actor_id uuid,
  actor_name text,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_member_audit_created_at on member_audit (created_at);

alter table members enable row level security;
alter table member_audit enable row level security;
-- Same zero-policy lockdown as the data tables — the app only ever reads
-- its own membership via sync_whoami(), and only the admin-users Edge
-- Function (using the service_role key, which bypasses RLS entirely) ever
-- lists/creates/disables members or writes to member_audit.

-- is_active_member() is what every sync_* function below calls instead of
-- checking a shared secret: true only for a signed-in, non-disabled member.
-- SECURITY DEFINER + owned by the table owner means it reads `members`
-- bypassing RLS, exactly like the sync_* functions that call it.
create or replace function is_active_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members where user_id = auth.uid() and not disabled
  );
$$;
revoke all on function is_active_member() from public;
grant execute on function is_active_member() to authenticated;

-- is_writer_member() is the extra check every WRITE sync_* function (put/
-- delete/post) calls on top of is_active_member(): a 'supervisor' is an
-- active member (can read everything — reports, lookups, stats) but is
-- never allowed to write. A read-only 'supervisor' role exists specifically
-- for people who should see data, not enter or change it — see index.html's
-- ACCESS CONTROL comments for the 3 roles (admin/user/supervisor).
create or replace function is_writer_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members where user_id = auth.uid() and not disabled and role <> 'supervisor'
  );
$$;
revoke all on function is_writer_member() from public;
grant execute on function is_writer_member() to authenticated;

-- Returns the caller's own membership row, or {"error":"unauthorized"} if
-- not signed in / not a member / disabled. This is how the app learns its
-- own display name + role after login (client code can never read `members`
-- directly — RLS blocks that on purpose).
create or replace function sync_whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row members;
begin
  select * into v_row from members where user_id = auth.uid() and not disabled;
  if not found then return jsonb_build_object('error', 'unauthorized'); end if;
  return jsonb_build_object('userId', v_row.user_id, 'displayName', v_row.display_name,
    'username', v_row.username, 'role', v_row.role);
end;
$$;
grant execute on function sync_whoami() to authenticated;

-- ===================== Checkpoints =====================

drop function if exists sync_get_checkpoints(text, bigint);
create or replace function sync_get_checkpoints(p_since bigint default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_cursor bigint;
begin
  if not is_active_member() then return jsonb_build_object('error', 'unauthorized'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', c.key, 'date', c.date, 'shift', c.shift, 'section', c.section, 'po', c.po,
      'recipe', c.recipe, 'client', c.client, 'technician', c.technician,
      'fields', c.fields, 'fieldNotes', c.field_notes, 'images', c.images,
      'updatedAt', c.updated_at, 'deleted', c.deleted
    ) order by c.seq), '[]'::jsonb), max(c.seq)
    into v_rows, v_cursor
  from (select * from checkpoints where seq > p_since order by seq limit 5000) c;
  return jsonb_build_object('rows', v_rows, 'cursor', coalesce(v_cursor, p_since), 'hasMore', jsonb_array_length(v_rows) = 5000);
end;
$$;

drop function if exists sync_put_checkpoints(text, jsonb);
create or replace function sync_put_checkpoints(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb;
  v_key text;
  v_updated_at text;
  v_current_updated_at text;
  v_results jsonb := '[]'::jsonb;
begin
  if not is_active_member() then return jsonb_build_object('error', 'unauthorized'); end if;
  if not is_writer_member() then return jsonb_build_object('error', 'forbidden_role'); end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_key := v_row->>'key';
    v_updated_at := v_row->>'updatedAt';
    if v_key is null or v_updated_at is null then
      v_results := v_results || jsonb_build_object('key', v_key, 'applied', false, 'reason', 'invalid');
      continue;
    end if;
    select updated_at into v_current_updated_at from checkpoints where key = v_key;
    insert into checkpoints (key, date, shift, section, po, recipe, client, technician, fields, field_notes, images, updated_at, deleted, seq)
    values (
      v_key, v_row->>'date', v_row->>'shift', v_row->>'section', coalesce(v_row->>'po', ''),
      coalesce(v_row->>'recipe', ''), coalesce(v_row->>'client', ''), coalesce(v_row->>'technician', ''),
      coalesce(v_row->'fields', '{}'::jsonb), coalesce(v_row->'fieldNotes', '{}'::jsonb), coalesce(v_row->'images', '[]'::jsonb),
      v_updated_at, false, nextval('checkpoints_seq')
    )
    on conflict (key) do update set
      date = excluded.date, shift = excluded.shift, section = excluded.section, po = excluded.po,
      recipe = excluded.recipe, client = excluded.client, technician = excluded.technician,
      fields = excluded.fields, field_notes = excluded.field_notes, images = excluded.images,
      updated_at = excluded.updated_at, deleted = false, seq = excluded.seq
    where excluded.updated_at > checkpoints.updated_at;
    v_results := v_results || jsonb_build_object('key', v_key, 'applied', v_current_updated_at is null or v_updated_at > v_current_updated_at);
  end loop;
  return jsonb_build_object('results', v_results);
end;
$$;

drop function if exists sync_delete_checkpoints(text, text[], text);
create or replace function sync_delete_checkpoints(p_keys text[], p_updated_at text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
begin
  if not is_active_member() then return jsonb_build_object('error', 'unauthorized'); end if;
  if not is_writer_member() then return jsonb_build_object('error', 'forbidden_role'); end if;
  foreach v_key in array p_keys loop
    insert into checkpoints (key, date, shift, section, po, recipe, client, technician, fields, field_notes, images, updated_at, deleted, seq)
    values (v_key, '', '', '', '', '', '', '', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, p_updated_at, true, nextval('checkpoints_seq'))
    on conflict (key) do update set deleted = true, updated_at = excluded.updated_at, seq = excluded.seq
    where excluded.updated_at > checkpoints.updated_at;
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

-- ===================== Meta (Specs/PO list/Recipe list/Client list/Technicians/PO closures) =====================

drop function if exists sync_get_meta(text);
create or replace function sync_get_meta() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_items jsonb;
begin
  if not is_active_member() then return jsonb_build_object('error', 'unauthorized'); end if;
  select coalesce(jsonb_object_agg(k, jsonb_build_object('value', value, 'updatedAt', updated_at)), '{}'::jsonb)
    into v_items from meta;
  return jsonb_build_object('items', v_items);
end;
$$;

drop function if exists sync_put_meta(text, jsonb);
create or replace function sync_put_meta(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
  v_val jsonb;
  v_updated_at text;
  v_current text;
  v_results jsonb := '{}'::jsonb;
begin
  if not is_active_member() then return jsonb_build_object('error', 'unauthorized'); end if;
  if not is_writer_member() then return jsonb_build_object('error', 'forbidden_role'); end if;
  for v_key, v_val in select * from jsonb_each(p_items) loop
    v_updated_at := v_val->>'updatedAt';
    if v_updated_at is null then
      v_results := v_results || jsonb_build_object(v_key, jsonb_build_object('applied', false, 'reason', 'invalid'));
      continue;
    end if;
    select updated_at into v_current from meta where k = v_key;
    insert into meta (k, value, updated_at) values (v_key, v_val->'value', v_updated_at)
    on conflict (k) do update set value = excluded.value, updated_at = excluded.updated_at
    where excluded.updated_at > meta.updated_at;
    v_results := v_results || jsonb_build_object(v_key, jsonb_build_object('applied', v_current is null or v_updated_at > v_current));
  end loop;
  return jsonb_build_object('results', v_results);
end;
$$;

-- ===================== Logs (Data Log audit trail) =====================

drop function if exists sync_post_logs(text, jsonb);
create or replace function sync_post_logs(p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_entry jsonb;
begin
  if not is_active_member() then return jsonb_build_object('error', 'unauthorized'); end if;
  if not is_writer_member() then return jsonb_build_object('error', 'forbidden_role'); end if;
  for v_entry in select * from jsonb_array_elements(p_entries) loop
    insert into logs (ts, date, shift, po, section, technician, changes)
    values (
      coalesce(v_entry->>'ts', now()::text), v_entry->>'date', v_entry->>'shift', v_entry->>'po',
      v_entry->>'section', v_entry->>'technician', coalesce(v_entry->'changes', '[]'::jsonb)
    );
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

-- ===================== Cleanup of the old shared-secret model =====================
-- Shiftly used to authorize every sync_* call with a shared password argument
-- (`set_sync_secret` / `check_secret` / `app_secret`) instead of real Auth
-- accounts. That model is fully replaced by `members` + `is_active_member()`
-- above — drop the now-unused pieces so no old-shaped call can slip through.

drop function if exists set_sync_secret(text);
drop function if exists check_secret(text);
drop table if exists app_secret;

-- ===================== Grants =====================
-- Every sync_* function below is granted to `authenticated` only (not
-- `anon`) — signing in with a real Supabase Auth account is now a
-- precondition just to call these, on top of the is_active_member() check
-- each one does internally. Postgres grants EXECUTE to PUBLIC on new
-- functions by default, so this also implicitly relies on the revoke above
-- for is_active_member() itself never being reachable except through these.
--
-- Note on images: attached photos travel as base64 `dataUrl` strings right
-- inside each checkpoint's `images` jsonb column (same shape the app already
-- keeps locally) — there is no separate images table/endpoint. Simpler and
-- plenty for this app's actual photo volume (a per-shift QC log, not a photo
-- host); revisit only if that changes.

grant execute on function sync_get_checkpoints(bigint) to authenticated;
grant execute on function sync_put_checkpoints(jsonb) to authenticated;
grant execute on function sync_delete_checkpoints(text[], text) to authenticated;
grant execute on function sync_get_meta() to authenticated;
grant execute on function sync_put_meta(jsonb) to authenticated;
grant execute on function sync_post_logs(jsonb) to authenticated;
