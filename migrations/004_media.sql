-- Uploaded images. Files live in storage at t/<tenant_id>/<file>; the site
-- JSON refers to them by file name only, so a name from another business
-- simply resolves to a path that doesn't exist under this business.
create table media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  file text not null check (file ~ '^[0-9a-f-]{16,36}\.(jpg|png|webp)$'),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes int not null check (bytes > 0),
  width int not null check (width > 0),
  height int not null check (height > 0),
  -- Original file name, for the owner's library only.
  name text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  unique (tenant_id, file),
  unique (tenant_id, id)
);
create index on media (tenant_id, created_at desc);

-- Team photos from the library. The composite key keeps them within the business.
alter table staff add column photo_file text;
alter table staff add constraint staff_photo_media foreign key (tenant_id, photo_file) references media (tenant_id, file);
