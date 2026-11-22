-- 0010: build notifications (mute per repo, on/off, daily summary). Additive and repeat-safe.
begin;
alter table app.telegram_users
  add column if not exists notify_off boolean not null default false,
  add column if not exists notify_daily boolean not null default false;

create table if not exists app.repo_mutes (
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  github_repo_id bigint not null,
  muted_at timestamptz not null default now(),
  primary key (telegram_user_id, github_repo_id)
);

create table if not exists app.build_notices (
  id bigserial primary key,
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  github_repo_id bigint not null,
  repo_full_name text not null,
  run_id bigint not null,
  conclusion text not null,
  created_at timestamptz not null default now()
);
create index if not exists build_notices_user_idx on app.build_notices (telegram_user_id, created_at desc);

alter table app.repo_mutes enable row level security;
alter table app.build_notices enable row level security;
revoke all on app.repo_mutes, app.build_notices from anon, authenticated;
commit;
