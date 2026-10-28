// The public site's content and layout, versioned: owners edit a draft,
// preview it, publish it, and can roll back to any earlier version.
// Publishing copies the version into tenants.name/content/theme/site, so
// everything that reads the tenant (site, messages, footer) sees the
// published version without knowing about versions.
import { sql, type Tx } from '../db.ts';
import { SECTION_TYPES, invalidateTenantCache, type SectionType, type SiteConfig, type Tenant, type TenantContent, type TenantTheme } from './tenants.ts';
import { TEMPLATES, type Template } from './design.ts';
import { FILE_RE } from './media.ts';

export interface SiteVersion {
  id: string;
  tenant_id: string;
  number: number;
  status: 'draft' | 'published' | 'archived';
  name: string;
  content: TenantContent;
  theme: TenantTheme;
  site: Partial<SiteConfig>;
  note: string;
  created_by: string;
  created_at: Date;
  published_at: Date | null;
}

/** What a version holds. */
export interface SiteFields {
  name: string;
  content: TenantContent;
  theme: TenantTheme;
  site: SiteConfig;
}

export const LIMITS = { gallery: 12, testimonials: 6, faq: 12 } as const;

export function defaultSite(): SiteConfig {
  return { template: 'classic', sections: SECTION_TYPES.map((type) => ({ type, enabled: true })), gallery: [], testimonials: [], faq: [] };
}

type Obj = Record<string, unknown>;
const text = (o: Obj, k: string, max: number): string => (typeof o[k] === 'string' ? (o[k] as string).trim().replace(/\u0000/g, '').slice(0, max) : '');
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : []);

/**
 * Cleans a stored or submitted layout: known section types only, each once,
 * in the given order; missing types are inserted at their default position
 * (enabled) so new section types show up on existing sites. Services must
 * stay on: it's how people book. Lists are trimmed to their limits and rows
 * without their required text are dropped. Gallery items are library file
 * names; anything else (e.g. an old external link) is dropped.
 */
export function normalizeSite(raw: unknown): SiteConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Obj;
  const seen = new Set<SectionType>();
  const sections: SiteConfig['sections'] = [];
  for (const s of list(input.sections)) {
    const type = s.type;
    if (typeof type !== 'string' || !(SECTION_TYPES as readonly string[]).includes(type) || seen.has(type as SectionType)) continue;
    seen.add(type as SectionType);
    sections.push({ type: type as SectionType, enabled: type === 'services' || s.enabled !== false });
  }
  for (const [i, type] of SECTION_TYPES.entries()) {
    if (seen.has(type)) continue;
    // Before the first present section that comes later in the default order.
    const later = sections.findIndex((x) => SECTION_TYPES.indexOf(x.type) > i);
    sections.splice(later < 0 ? sections.length : later, 0, { type, enabled: true });
  }

  const gallery = list(input.gallery)
    .map((g) => ({ file: text(g, 'file', 60), alt_pt: text(g, 'alt_pt', 140), alt_en: text(g, 'alt_en', 140) }))
    .filter((g) => FILE_RE.test(g.file))
    .slice(0, LIMITS.gallery);
  const testimonials = list(input.testimonials)
    .map((q) => ({ quote_pt: text(q, 'quote_pt', 400), quote_en: text(q, 'quote_en', 400), author: text(q, 'author', 60) }))
    .filter((q) => q.quote_pt || q.quote_en)
    .slice(0, LIMITS.testimonials);
  const faq = list(input.faq)
    .map((f) => ({ q_pt: text(f, 'q_pt', 160), q_en: text(f, 'q_en', 160), a_pt: text(f, 'a_pt', 800), a_en: text(f, 'a_en', 800) }))
    .filter((f) => (f.q_pt && f.a_pt) || (f.q_en && f.a_en))
    .slice(0, LIMITS.faq);

  const template = (TEMPLATES as readonly string[]).includes(input.template as string) ? (input.template as Template) : 'classic';
  return { template, sections, gallery, testimonials, faq };
}

export function sectionEnabled(site: Partial<SiteConfig>, type: SectionType): boolean {
  return normalizeSite(site).sections.find((s) => s.type === type)?.enabled ?? true;
}

function fieldsOf(v: Pick<SiteVersion, 'name' | 'content' | 'theme' | 'site'>): SiteFields {
  return { name: v.name, content: v.content ?? {}, theme: v.theme ?? {}, site: normalizeSite(v.site) };
}

/** Stable comparison so re-applying identical content doesn't create versions. */
export function sameFields(a: SiteFields, b: SiteFields): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== '').sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, canon(x)]))
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export async function publishedVersion(tenantId: string, tx: Tx = sql): Promise<SiteVersion | null> {
  const [v] = await tx<SiteVersion[]>`select * from site_versions where tenant_id = ${tenantId} and status = 'published'`;
  return v ?? null;
}

export async function draftVersion(tenantId: string, tx: Tx = sql): Promise<SiteVersion | null> {
  const [v] = await tx<SiteVersion[]>`select * from site_versions where tenant_id = ${tenantId} and status = 'draft'`;
  return v ?? null;
}

export async function listVersions(tenantId: string, limit = 30): Promise<SiteVersion[]> {
  return sql<SiteVersion[]>`select * from site_versions where tenant_id = ${tenantId} order by number desc limit ${limit}`;
}

/** The tenant as the public sees it, with a version's site fields swapped in (for previews). */
export function withVersion(tenant: Tenant, v: Pick<SiteVersion, 'name' | 'content' | 'theme' | 'site'>): Tenant {
  const f = fieldsOf(v);
  return { ...tenant, name: f.name, content: f.content, theme: f.theme, site: f.site };
}

async function nextNumber(tx: Tx, tenantId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`select coalesce(max(number), 0)::int + 1 as n from site_versions where tenant_id = ${tenantId}`;
  return r.n;
}

/** Serialises version changes per tenant. */
async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  const rows = await tx`select 1 from tenants where id = ${tenantId} for update`;
  if (!rows.length) throw new Error('Unknown tenant');
}

/**
 * Applies a change to the draft, creating the draft from the published
 * version first if there is none.
 */
export async function saveDraft(tenantId: string, change: (current: SiteFields) => SiteFields, by: string): Promise<SiteVersion> {
  return sql.begin(async (tx) => {
    await lockTenant(tx, tenantId);
    const draft = await draftVersion(tenantId, tx);
    const base = draft ?? (await publishedVersion(tenantId, tx));
    // A tenant created before it had any version starts from its live fields.
    const [live] = base ? [base] : await tx<SiteVersion[]>`select name, content, theme, site from tenants where id = ${tenantId}`;
    const next = change(fieldsOf(live));
    next.site = normalizeSite(next.site);
    if (draft) {
      const [v] = await tx<SiteVersion[]>`
        update site_versions set name = ${next.name}, content = ${tx.json(next.content as never)}, theme = ${tx.json(next.theme as never)},
          site = ${tx.json(next.site as never)}, created_by = ${by}, created_at = now()
        where id = ${draft.id} returning *`;
      return v;
    }
    const [v] = await tx<SiteVersion[]>`
      insert into site_versions (tenant_id, number, status, name, content, theme, site, created_by)
      values (${tenantId}, ${await nextNumber(tx, tenantId)}, 'draft', ${next.name}, ${tx.json(next.content as never)},
        ${tx.json(next.theme as never)}, ${tx.json(next.site as never)}, ${by})
      returning *`;
    return v;
  });
}

export async function discardDraft(tenantId: string): Promise<boolean> {
  const r = await sql`delete from site_versions where tenant_id = ${tenantId} and status = 'draft'`;
  return r.count > 0;
}

async function makeLive(tx: Tx, tenantId: string, v: SiteVersion, userId: string | null, action: string): Promise<void> {
  await tx`update site_versions set status = 'archived' where tenant_id = ${tenantId} and status = 'published' and id <> ${v.id}`;
  await tx`update site_versions set status = 'published', published_at = now() where id = ${v.id}`;
  const f = fieldsOf(v);
  await tx`update tenants set name = ${f.name}, content = ${tx.json(f.content as never)}, theme = ${tx.json(f.theme as never)},
    site = ${tx.json(f.site as never)}, updated_at = now() where id = ${tenantId}`;
  await tx`insert into audit_log (tenant_id, user_id, action, details) values (${tenantId}, ${userId}, ${action}, ${tx.json({ version: v.number } as never)})`;
}

/** Publishes the draft. Returns null if there is no draft. */
export async function publishDraft(tenantId: string, userId: string | null): Promise<SiteVersion | null> {
  const v = await sql.begin(async (tx) => {
    await lockTenant(tx, tenantId);
    const draft = await draftVersion(tenantId, tx);
    if (!draft) return null;
    await makeLive(tx, tenantId, draft, userId, 'site.publish');
    return draft;
  });
  invalidateTenantCache();
  return v;
}

/**
 * Rolls back by publishing a copy of an earlier version as a new version, so
 * history stays linear ("v7: restored v3"). An open draft is left alone.
 */
export async function restoreVersion(tenantId: string, versionId: string, userId: string | null, by: string): Promise<SiteVersion | null> {
  const v = await sql.begin(async (tx) => {
    await lockTenant(tx, tenantId);
    // tenant_id in the WHERE: a version id from another tenant is simply not found.
    const [old] = await tx<SiteVersion[]>`select * from site_versions where tenant_id = ${tenantId} and id = ${versionId} and status <> 'draft'`;
    if (!old) return null;
    const [copy] = await tx<SiteVersion[]>`
      insert into site_versions (tenant_id, number, status, name, content, theme, site, note, created_by)
      values (${tenantId}, ${await nextNumber(tx, tenantId)}, 'archived', ${old.name}, ${tx.json(old.content as never)},
        ${tx.json(old.theme as never)}, ${tx.json(normalizeSite(old.site) as never)}, ${`Restored version ${old.number}`}, ${by})
      returning *`;
    await makeLive(tx, tenantId, copy, userId, 'site.restore');
    return copy;
  });
  invalidateTenantCache();
  return v;
}

/**
 * Publishes the given fields directly (used by the client file script).
 * No-op if they match the published version. Returns the new version or null.
 */
export async function publishFields(tx: Tx, tenantId: string, fields: SiteFields, by: string, note: string): Promise<SiteVersion | null> {
  await lockTenant(tx, tenantId);
  const current = await publishedVersion(tenantId, tx);
  const next = { ...fields, site: normalizeSite(fields.site) };
  if (current && sameFields(fieldsOf(current), next)) return null;
  const [v] = await tx<SiteVersion[]>`
    insert into site_versions (tenant_id, number, status, name, content, theme, site, note, created_by)
    values (${tenantId}, ${await nextNumber(tx, tenantId)}, 'archived', ${next.name}, ${tx.json(next.content as never)},
      ${tx.json(next.theme as never)}, ${tx.json(next.site as never)}, ${note}, ${by})
    returning *`;
  await makeLive(tx, tenantId, v, null, 'site.publish');
  return v;
}
