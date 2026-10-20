-- Reservo schema. One database serves every tenant (studio); every row
-- carries tenant_id and composite foreign keys stop rows of one tenant from
-- pointing at rows of another.

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null,
  status text not null default 'active' check (status in ('demo','trial','active','suspended')),
  trial_ends_at timestamptz,
  timezone text not null default 'Europe/Lisbon',
  default_locale text not null default 'pt' check (default_locale in ('pt','en')),
  -- Public site content (texts in pt/en, contacts, address)
  content jsonb not null default '{}'::jsonb,
  -- Branding: colours, logo
  theme jsonb not null default '{}'::jsonb,
  -- Booking policy
  slot_interval_min int not null default 15 check (slot_interval_min between 5 and 120),
  min_lead_min int not null default 120 check (min_lead_min >= 0),
  max_advance_days int not null default 60 check (max_advance_days between 1 and 365),
  cancel_window_hours int not null default 24 check (cancel_window_hours >= 0),
  payment_mode text not null default 'deposit' check (payment_mode in ('none','deposit','full')),
  deposit_percent int not null default 30 check (deposit_percent between 1 and 100),
  pay_at_studio_allowed boolean not null default false,
  mbway_hold_min int not null default 10 check (mbway_hold_min between 5 and 60),
  multibanco_hold_hours int not null default 24 check (multibanco_hold_hours between 1 and 168),
  payment_provider text not null default 'none' check (payment_provider in ('none','mock','ifthenpay')),
  -- AES-256-GCM encrypted JSON: { mbKey, mbwayKey, antiPhishingKey }
  payment_secrets bytea,
  notify_owner_email text,
  notify_owner_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tenant_domains (
  domain text primary key check (domain = lower(domain)),
  tenant_id uuid not null references tenants(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index on tenant_domains (tenant_id);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  name text not null,
  password_hash text not null,
  role text not null default 'owner' check (role in ('owner','staff')),
  locale text not null default 'pt',
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_tenant_email on users (tenant_id, lower(email));

create table sessions (
  id_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  csrf_token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index on sessions (expires_at);

create table staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  title_pt text not null default '',
  title_en text not null default '',
  bio_pt text not null default '',
  bio_en text not null default '',
  photo_url text,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  category text not null default '',
  name_pt text not null,
  name_en text not null default '',
  description_pt text not null default '',
  description_en text not null default '',
  duration_min int not null check (duration_min between 5 and 600),
  buffer_min int not null default 0 check (buffer_min between 0 and 120),
  price_cents int not null check (price_cents >= 0),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table staff_services (
  tenant_id uuid not null,
  staff_id uuid not null,
  service_id uuid not null,
  primary key (staff_id, service_id),
  foreign key (tenant_id, staff_id) references staff(tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id) references services(tenant_id, id) on delete cascade
);

-- Weekly working hours. Several rows per weekday allow split shifts.
create table working_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_min int not null check (start_min between 0 and 1440),
  end_min int not null check (end_min between 0 and 1440),
  check (end_min > start_min),
  foreign key (tenant_id, staff_id) references staff(tenant_id, id) on delete cascade
);
create index on working_hours (tenant_id, staff_id);

-- Holidays, sick days, breaks. staff_id null = whole studio closed.
create table time_off (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  staff_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default '',
  check (ends_at > starts_at),
  foreign key (tenant_id, staff_id) references staff(tenant_id, id) on delete cascade
);
create index on time_off (tenant_id, starts_at);

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  phone text not null,
  email text,
  locale text not null default 'pt',
  privacy_accepted_at timestamptz,
  marketing_consent boolean not null default false,
  notes text not null default '',
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index customers_tenant_phone on customers (tenant_id, phone) where anonymized_at is null;

create table bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ref text not null,
  customer_id uuid not null,
  staff_id uuid not null,
  service_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- ends_at + cleanup buffer; this is what blocks the calendar
  blocked_until timestamptz not null,
  status text not null check (status in ('pending_payment','confirmed','cancelled','completed','no_show')),
  source text not null default 'online' check (source in ('online','admin')),
  price_cents int not null,
  amount_due_cents int not null default 0,
  paid_cents int not null default 0,
  hold_expires_at timestamptz,
  customer_note text not null default '',
  manage_token_hash text not null,
  locale text not null default 'pt',
  reminder_sent_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and blocked_until >= ends_at),
  unique (tenant_id, ref),
  foreign key (tenant_id, customer_id) references customers(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  -- The database itself guarantees a therapist can never be double-booked,
  -- even with many app instances booking at the same instant.
  constraint bookings_no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, blocked_until, '[)') with &&
  ) where (status in ('pending_payment','confirmed'))
);
create index on bookings (tenant_id, starts_at);
create index on bookings (status, hold_expires_at) where status = 'pending_payment';
create index on bookings (status, starts_at) where status = 'confirmed' and reminder_sent_at is null;

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  booking_id uuid not null references bookings(id) on delete cascade,
  provider text not null check (provider in ('mock','ifthenpay','manual')),
  method text not null check (method in ('mbway','multibanco','card','cash','card_terminal','transfer')),
  -- Order id sent to the gateway (max 15 chars for MB WAY)
  order_id text not null,
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired','refunded')),
  provider_request_id text,
  mb_entity text,
  mb_reference text,
  phone text,
  expires_at timestamptz,
  paid_at timestamptz,
  last_checked_at timestamptz,
  status_detail text,
  created_at timestamptz not null default now(),
  unique (provider, order_id)
);
create index on payments (booking_id);
create index on payments (status, method, created_at) where status = 'pending';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  channel text not null,
  template text not null,
  recipient text not null,
  status text not null,
  error text,
  created_at timestamptz not null default now()
);
create index on notifications (tenant_id, created_at desc);

create table audit_log (
  id bigserial primary key,
  tenant_id uuid references tenants(id) on delete cascade,
  user_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on audit_log (tenant_id, created_at desc);

-- Fixed-window rate limiting shared by all app instances.
create unlogged table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);
