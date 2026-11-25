-- Interview Coach: database, storage and access rules.
-- Run once in Supabase → SQL Editor.
--
-- Who can see what
--   Student: their own sessions, answers (transcript, AI content notes, basic
--            metrics) and recordings. They can WRITE the full analysis but
--            cannot read it back.
--   Coach:   every session a student has submitted, including recordings and
--            the full analysis (face and voice measurements, timeline).
--   Nobody can make themselves a coach from the app. Promote a coach here:
--     update public.profiles set role = 'coach' where id = (select id from auth.users where email = 'coach@example.com');

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  role text not null default 'student' check (role in ('student', 'coach')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name) values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_coach() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'coach');
$$;

-- Students may change their name but never their role.
create or replace function public.protect_role() returns trigger
language plpgsql as $$
begin
  if new.role is distinct from old.role and current_user = 'authenticated' then
    raise exception 'role cannot be changed from the app';
  end if;
  return new;
end $$;
drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role before update on public.profiles
  for each row execute function public.protect_role();

-- ---------------------------------------------------------------- sessions
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('expert', 'peer')),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'reviewed')),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  coach_id uuid references public.profiles(id),
  coach_feedback jsonb
);
alter table public.sessions drop constraint if exists sessions_student_id_fkey;
alter table public.sessions add constraint sessions_student_id_fkey foreign key (student_id) references public.profiles(id) on delete cascade;

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  idx int not null,
  question_id text,
  question text not null,
  category text,
  transcript text,
  duration_s int,
  student_metrics jsonb,   -- what the student sees
  ai_feedback jsonb,       -- content notes only
  has_video boolean,
  mime_type text,
  video_path text,
  created_at timestamptz not null default now()
);
create index if not exists answers_session_idx on public.answers(session_id);

-- Coach-only: full measurements and timeline
create table if not exists public.answer_analysis (
  answer_id uuid primary key references public.answers(id) on delete cascade,
  metrics jsonb,
  timeline jsonb,
  events jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.answers enable row level security;
alter table public.answer_analysis enable row level security;

drop policy if exists "profiles: read own or coach" on public.profiles;
create policy "profiles: read own or coach" on public.profiles for select
  using (id = auth.uid() or public.is_coach());
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- sessions
drop policy if exists "sessions: student read own" on public.sessions;
create policy "sessions: student read own" on public.sessions for select using (student_id = auth.uid());
drop policy if exists "sessions: student create" on public.sessions;
create policy "sessions: student create" on public.sessions for insert
  with check (student_id = auth.uid() and status = 'draft');
drop policy if exists "sessions: student submit" on public.sessions;
create policy "sessions: student submit" on public.sessions for update
  using (student_id = auth.uid() and status = 'draft')
  with check (student_id = auth.uid() and status in ('draft', 'submitted') and coach_feedback is null);
drop policy if exists "sessions: student delete" on public.sessions;
create policy "sessions: student delete" on public.sessions for delete using (student_id = auth.uid());
drop policy if exists "sessions: coach read submitted" on public.sessions;
create policy "sessions: coach read submitted" on public.sessions for select
  using (public.is_coach() and status <> 'draft');
drop policy if exists "sessions: coach review" on public.sessions;
create policy "sessions: coach review" on public.sessions for update
  using (public.is_coach() and status <> 'draft')
  with check (public.is_coach() and status = 'reviewed');

-- answers
drop policy if exists "answers: student read own" on public.answers;
create policy "answers: student read own" on public.answers for select
  using (exists (select 1 from public.sessions s where s.id = session_id and s.student_id = auth.uid()));
drop policy if exists "answers: student add to draft" on public.answers;
create policy "answers: student add to draft" on public.answers for insert
  with check (exists (select 1 from public.sessions s where s.id = session_id and s.student_id = auth.uid() and s.status = 'draft'));
drop policy if exists "answers: coach read submitted" on public.answers;
create policy "answers: coach read submitted" on public.answers for select
  using (public.is_coach() and exists (select 1 from public.sessions s where s.id = session_id and s.status <> 'draft'));

-- analysis: students can only insert; coaches can read
drop policy if exists "analysis: student insert" on public.answer_analysis;
create policy "analysis: student insert" on public.answer_analysis for insert
  with check (exists (
    select 1 from public.answers a join public.sessions s on s.id = a.session_id
    where a.id = answer_id and s.student_id = auth.uid() and s.status = 'draft'));
drop policy if exists "analysis: coach read" on public.answer_analysis;
create policy "analysis: coach read" on public.answer_analysis for select
  using (public.is_coach() and exists (
    select 1 from public.answers a join public.sessions s on s.id = a.session_id
    where a.id = answer_id and s.status <> 'draft'));

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public) values ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- Files live at <student_id>/<session_id>/<file>
drop policy if exists "recordings: student upload own" on storage.objects;
create policy "recordings: student upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "recordings: student read own" on storage.objects;
create policy "recordings: student read own" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "recordings: student delete own" on storage.objects;
create policy "recordings: student delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "recordings: coach read submitted" on storage.objects;
create policy "recordings: coach read submitted" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and public.is_coach() and exists (
    select 1 from public.sessions s
    where s.id::text = (storage.foldername(name))[2] and s.status <> 'draft'));

-- ---------------------------------------------------------------- retention
-- Optional: delete sessions (and their rows) older than 90 days.
-- Recordings must also be removed from storage; see README → Retention.
-- create extension if not exists pg_cron;
-- select cron.schedule('delete-old-sessions', '0 3 * * *',
--   $$ delete from public.sessions where created_at < now() - interval '90 days' $$);
