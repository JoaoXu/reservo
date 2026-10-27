-- Business types, configurable site sections, and versioned site content
-- (draft / publish / rollback). Additive: the previous app version keeps
-- reading tenants.name/content/theme, which always hold the published version.

alter table tenants add column business_type text not null default 'massage'
  check (business_type in ('massage', 'salon', 'barber', 'beauty'));

-- Published layout: { "template": "classic", "sections": [{ "type": "hero", "enabled": true }, ...] }
alter table tenants add column site jsonb not null default '{}'::jsonb;

-- Every edit of the public site is a version. At most one draft (being edited)
-- and one published version per tenant; the rest are history for rollback.
-- Publishing copies name/content/theme/site into tenants.
create table site_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number int not null check (number > 0),
  status text not null check (status in ('draft', 'published', 'archived')),
  name text not null,
  content jsonb not null default '{}'::jsonb,
  theme jsonb not null default '{}'::jsonb,
  site jsonb not null default '{}'::jsonb,
  note text not null default '',
  -- Who made it: a user's name, or "tenant:apply" for the client file script.
  created_by text not null default '',
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (tenant_id, number),
  unique (tenant_id, id)
);
create unique index site_versions_one_draft on site_versions (tenant_id) where status = 'draft';
create unique index site_versions_one_published on site_versions (tenant_id) where status = 'published';

insert into site_versions (tenant_id, number, status, name, content, theme, site, note, created_by, published_at)
select id, 1, 'published', name, content, theme, site, 'Initial version', 'migration', now() from tenants;
