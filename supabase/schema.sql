-- Shiftly Report — Supabase (Postgres) backend
-- Run ONCE in the Supabase Dashboard → SQL Editor → New query → paste this
-- whole file → Run. No CLI/terminal needed.
--
-- Design: every real table is locked down (RLS enabled, no policies), and
-- the ONLY way in is through the sync_* functions below (SECURITY DEFINER,
-- so they run with the owner's privileges and bypass RLS regardless of who
-- calls them). Each one takes the shared secret as its first argument and
-- checks it itself — same "one shared password" model the app used with
-- its previous Cloudflare backend, just implemented in Postgres.
--
-- Every sync_* function always returns a JSON object and HTTP 200 — even
-- on a wrong secret, which comes back as {"error":"unauthorized"} rather
-- than a raised SQL exception. This is deliberate: PostgREST's mapping of
-- arbitrary raised Postgres error codes to HTTP status codes isn't
-- something to depend on sight-unseen, whereas "read `error` in the JSON
-- body" is unambiguous and works identically in the app and in tests.
--
-- The sync cursor (`seq`) is a Postgres SEQUENCE, assigned per row on every
-- write — always increasing, never based on any device's clock (a phone or
-- PC with the wrong time must never cause another device to silently miss
-- data — see index.html's cloud-sync comments for the history of that bug).

-- On Supabase this installs into an `extensions` schema (not `public`) by
-- default — that's why the 2 functions below that call digest() set
-- search_path to "public, extensions" rather than just "public". Postgres
-- silently skips schemas in search_path that don't exist, so this is safe
-- unchanged even somewhere pgcrypto's functions land directly in `public`.
create extension if not exists pgcrypto;

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

create table if not exists app_secret (
  id int primary key check (id = 1),
  secret_hash bytea not null
);

alter table checkpoints enable row level security;
alter table meta enable row level security;
alter table logs enable row level security;
alter table app_secret enable row level security;
-- No policies are created for any of them — RLS with zero policies denies
-- all direct REST access (anon/authenticated), which is exactly the point.

-- ===================== Secret management =====================
-- set_sync_secret is intentionally NEVER granted to anon/authenticated —
-- it can only be run from the SQL Editor (as the table owner), which is
-- the one-time setup step. See supabase/README.md.

create or replace function set_sync_secret(p_secret text) returns void
language sql security definer set search_path = public, extensions as $$
  insert into app_secret (id, secret_hash) values (1, digest(p_secret, 'sha256'))
  on conflict (id) do update set secret_hash = excluded.secret_hash;
$$;

create or replace function check_secret(p_secret text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from app_secret where id = 1 and secret_hash = digest(coalesce(p_secret, ''), 'sha256')
  );
$$;

revoke all on function set_sync_secret(text) from public;
revoke all on function check_secret(text) from public;

-- ===================== Checkpoints =====================

create or replace function sync_get_checkpoints(p_secret text, p_since bigint default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows jsonb;
  v_cursor bigint;
begin
  if not check_secret(p_secret) then return jsonb_build_object('error', 'unauthorized'); end if;
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

create or replace function sync_put_checkpoints(p_secret text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb;
  v_key text;
  v_updated_at text;
  v_current_updated_at text;
  v_results jsonb := '[]'::jsonb;
begin
  if not check_secret(p_secret) then return jsonb_build_object('error', 'unauthorized'); end if;
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

create or replace function sync_delete_checkpoints(p_secret text, p_keys text[], p_updated_at text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
begin
  if not check_secret(p_secret) then return jsonb_build_object('error', 'unauthorized'); end if;
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

create or replace function sync_get_meta(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_items jsonb;
begin
  if not check_secret(p_secret) then return jsonb_build_object('error', 'unauthorized'); end if;
  select coalesce(jsonb_object_agg(k, jsonb_build_object('value', value, 'updatedAt', updated_at)), '{}'::jsonb)
    into v_items from meta;
  return jsonb_build_object('items', v_items);
end;
$$;

create or replace function sync_put_meta(p_secret text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
  v_val jsonb;
  v_updated_at text;
  v_current text;
  v_results jsonb := '{}'::jsonb;
begin
  if not check_secret(p_secret) then return jsonb_build_object('error', 'unauthorized'); end if;
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

create or replace function sync_post_logs(p_secret text, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_entry jsonb;
begin
  if not check_secret(p_secret) then return jsonb_build_object('error', 'unauthorized'); end if;
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

-- ===================== Grants =====================
-- Postgres grants EXECUTE to the PUBLIC pseudo-role on every new function
-- by default — the two revokes above already lock down the secret-setting
-- functions. Everything below is meant to be reachable via the anon key
-- (each function checks p_secret itself, same threat model as before).
--
-- Note on images: attached photos travel as base64 `dataUrl` strings right
-- inside each checkpoint's `images` jsonb column (same shape the app already
-- keeps locally) — there is no separate images table/endpoint. Simpler and
-- plenty for this app's actual photo volume (a per-shift QC log, not a photo
-- host); revisit only if that changes.

grant execute on function sync_get_checkpoints(text, bigint) to anon, authenticated;
grant execute on function sync_put_checkpoints(text, jsonb) to anon, authenticated;
grant execute on function sync_delete_checkpoints(text, text[], text) to anon, authenticated;
grant execute on function sync_get_meta(text) to anon, authenticated;
grant execute on function sync_put_meta(text, jsonb) to anon, authenticated;
grant execute on function sync_post_logs(text, jsonb) to anon, authenticated;
