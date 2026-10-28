// The curated design choices for a business's site: layout template, font
// pairing and colour palette. Owners pick from these (or custom colours that
// pass the contrast rules), so every site stays readable and on-brand.

export const TEMPLATES = ['classic', 'studio'] as const;
export type Template = (typeof TEMPLATES)[number];

export const TEMPLATE_INFO: Record<Template, { pt: string; en: string; hint_pt: string; hint_en: string; font: Font }> = {
  classic: { pt: 'Clássico', en: 'Classic', hint_pt: 'Calmo e leve, letras serifadas. Bom para massagem, spa e estética.', hint_en: 'Calm and light, serif headings. Suits massage, spa and beauty.', font: 'serif' },
  studio: { pt: 'Estúdio', en: 'Studio', hint_pt: 'Forte e escuro, títulos em maiúsculas. Bom para barbearias e cabeleireiros.', hint_en: 'Bold and dark, uppercase headings. Suits barbers and hair salons.', font: 'sans' },
};

// Both fonts are self-hosted variable fonts (see public/fonts).
export const FONTS = ['serif', 'sans'] as const;
export type Font = (typeof FONTS)[number];

export const FONT_INFO: Record<Font, { pt: string; en: string }> = {
  serif: { pt: 'Serifada nos títulos (Newsreader + Figtree)', en: 'Serif headings (Newsreader + Figtree)' },
  sans: { pt: 'Sem serifa (Figtree)', en: 'Sans-serif (Figtree)' },
};

export interface Palette { ink: string; paper: string; accent: string; soft: string }

/** Presets, all checked against the contrast rules in the tests. */
export const PALETTES: Record<string, Palette & { pt: string; en: string }> = {
  salvia: { pt: 'Sálvia', en: 'Sage', ink: '#1d3a35', paper: '#eef2ee', accent: '#7a4e63', soft: '#dfe7e1' },
  terracota: { pt: 'Terracota', en: 'Terracotta', ink: '#3b2a22', paper: '#f7f1ea', accent: '#9a3f24', soft: '#ece0d3' },
  carvao: { pt: 'Carvão e latão', en: 'Charcoal and brass', ink: '#1c1c1c', paper: '#f2f0eb', accent: '#7a5a12', soft: '#e3dfd5' },
  rosa: { pt: 'Rosa antigo', en: 'Dusty rose', ink: '#3d2830', paper: '#fbf4f4', accent: '#9c3656', soft: '#f2e2e6' },
  oceano: { pt: 'Oceano', en: 'Ocean', ink: '#13314a', paper: '#eef3f7', accent: '#1d6585', soft: '#dbe7ee' },
  oliva: { pt: 'Oliveira', en: 'Olive', ink: '#2b3020', paper: '#f4f3ec', accent: '#5e5c1e', soft: '#e5e3d4' },
};

export const DEFAULT_PALETTE = 'salvia';

// --- Contrast (WCAG 2.x) ------------------------------------------------------
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text is small (15-17px) everywhere these colours meet, so all pairs need 4.5:1. */
export const CONTRAST_RULES: { a: keyof Palette; b: keyof Palette; pt: string; en: string }[] = [
  { a: 'ink', b: 'paper', pt: 'texto sobre o fundo', en: 'text on the background' },
  { a: 'ink', b: 'soft', pt: 'texto sobre as superfícies', en: 'text on surfaces' },
  { a: 'accent', b: 'paper', pt: 'destaque sobre o fundo', en: 'highlight on the background' },
];
export const MIN_CONTRAST = 4.5;

/** Contrast problems for a palette, empty if it's readable. */
export function contrastProblems(p: Palette): { rule: (typeof CONTRAST_RULES)[number]; ratio: number }[] {
  return CONTRAST_RULES
    .map((rule) => ({ rule, ratio: contrast(p[rule.a], p[rule.b]) }))
    .filter((x) => x.ratio < MIN_CONTRAST);
}
