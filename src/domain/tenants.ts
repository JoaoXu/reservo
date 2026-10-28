import { sql, type Tx } from '../db.ts';
import { config } from '../config.ts';
import { decryptJson, encryptJson } from '../lib/crypto.ts';
import type { IfthenpayKeys } from './payments/ifthenpay.ts';
import type { Font, Template } from './design.ts';

export interface TenantContent {
  tagline_pt?: string; tagline_en?: string;
  intro_pt?: string; intro_en?: string;
  about_pt?: string; about_en?: string;
  policy_pt?: string; policy_en?: string;
  address?: string; city?: string; postal_code?: string;
  map_url?: string;
  phone?: string; whatsapp?: string; email?: string; instagram?: string;
  hours_note_pt?: string; hours_note_en?: string;
  nif?: string; legal_name?: string;
}

export interface TenantTheme {
  ink?: string; // main text and buttons
  paper?: string; // page background
  accent?: string; // selected states, highlights
  soft?: string; // secondary surfaces
  logo_url?: string;
  hero_image_url?: string;
  /** Preset key from design.ts PALETTES, or 'custom'. */
  palette?: string;
  font?: Font;
}

export const BUSINESS_TYPES = ['massage', 'salon', 'barber', 'beauty'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

// Default order; sections added later slot in at their position here.
export const SECTION_TYPES = ['hero', 'services', 'about', 'team', 'gallery', 'testimonials', 'faq', 'visit'] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export interface GalleryItem { url: string; alt_pt: string; alt_en: string }
export interface Testimonial { quote_pt: string; quote_en: string; author: string }
export interface FaqItem { q_pt: string; q_en: string; a_pt: string; a_en: string }

/** Layout and section content of the public site. */
export interface SiteConfig {
  template: Template;
  sections: { type: SectionType; enabled: boolean }[];
  gallery: GalleryItem[];
  testimonials: Testimonial[];
  faq: FaqItem[];
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'demo' | 'trial' | 'active' | 'suspended';
  business_type: BusinessType;
  timezone: string;
  default_locale: 'pt' | 'en';
  content: TenantContent;
  theme: TenantTheme;
  site: Partial<SiteConfig>;
  slot_interval_min: number;
  min_lead_min: number;
  max_advance_days: number;
  cancel_window_hours: number;
  payment_mode: 'none' | 'deposit' | 'full';
  deposit_percent: number;
  pay_at_studio_allowed: boolean;
  mbway_hold_min: number;
  multibanco_hold_hours: number;
  payment_provider: 'none' | 'mock' | 'ifthenpay';
  payment_secrets: Buffer | null;
  notify_owner_email: string | null;
  notify_owner_phone: string | null;
  primary_domain: string | null;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; tenant: Tenant | null }>();

export function normalizeHost(hostHeader: string | undefined): string {
  return (hostHeader ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** Finds the studio for a request: custom domain first, then <slug>.<platform domain>. */
export async function tenantForHost(host: string): Promise<Tenant | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tenant;

  let rows = await sql<Tenant[]>`
    select t.*, (select domain from tenant_domains p where p.tenant_id = t.id and p.is_primary limit 1) as primary_domain
    from tenant_domains d join tenants t on t.id = d.tenant_id
    where d.domain = ${host} and t.status <> 'suspended'`;
  if (!rows.length && host.endsWith('.' + config.platformDomain)) {
    const slug = host.slice(0, -(config.platformDomain.length + 1));
    rows = await sql<Tenant[]>`
      select t.*, (select domain from tenant_domains p where p.tenant_id = t.id and p.is_primary limit 1) as primary_domain
      from tenants t where slug = ${slug} and status <> 'suspended'`;
  }
  const tenant = rows[0] ?? null;
  cache.set(host, { at: Date.now(), tenant });
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  return tenant;
}

export async function tenantById(id: string, tx: Tx = sql): Promise<Tenant | null> {
  const rows = await tx<Tenant[]>`
    select t.*, (select domain from tenant_domains p where p.tenant_id = t.id and p.is_primary limit 1) as primary_domain
    from tenants t where id = ${id}`;
  return rows[0] ?? null;
}

export function invalidateTenantCache(): void {
  cache.clear();
}

export function paymentKeys(t: Pick<Tenant, 'payment_secrets'>): IfthenpayKeys {
  return decryptJson<IfthenpayKeys>(t.payment_secrets) ?? {};
}

export function sealPaymentKeys(keys: IfthenpayKeys): Buffer {
  return encryptJson(keys);
}

/** Base URL of the studio's public site, for links in messages. */
export function tenantBaseUrl(t: Pick<Tenant, 'primary_domain' | 'slug'>): string {
  if (t.primary_domain) {
    const local = t.primary_domain.endsWith('localhost');
    return `${local ? 'http' : 'https'}://${t.primary_domain}${local ? `:${config.port}` : ''}`;
  }
  const local = config.platformDomain === 'localhost';
  return `${local ? 'http' : 'https'}://${t.slug}.${config.platformDomain}${local ? `:${config.port}` : ''}`;
}

export function mockPaymentsAllowed(t: Pick<Tenant, 'status'>): boolean {
  return config.allowMockPayments || t.status === 'demo';
}
