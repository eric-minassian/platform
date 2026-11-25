import { crc32, deflateSync } from 'node:zlib';
import type {
  AssetCategoryType,
  AssetExtensionType,
  ColorSchemeModeType,
  CreateManagedLoginBrandingRequest,
} from '@aws-sdk/client-cognito-identity-provider';
import { GEIST_SEMIBOLD, type GlyphSet } from './login-glyphs.ts';

/**
 * The managed login style every app client gets, after the console and
 * Vercel's login page: a header with the platform's mark and domain (one
 * account across every app), the app's name over a form without a card, the
 * console's neutral greys, and the device's light or dark mode.
 *
 * Cognito takes colors and images, but no fonts or copy, so the names are
 * drawn as Geist outlines. Its page font (Open Sans), its copy and its italic
 * placeholders stay as they are.
 */
export interface LoginBranding {
  /** The style's settings document, as Cognito stores and returns it. */
  settings: Settings;
  assets: Array<{
    Category: AssetCategoryType;
    ColorMode: ColorSchemeModeType;
    Extension: AssetExtensionType;
    Bytes: Uint8Array;
  }>;
}

type Settings = NonNullable<CreateManagedLoginBrandingRequest['Settings']>;

export function loginBranding(spec: { app: string; domain: string }): LoginBranding {
  const assets: LoginBranding['assets'] = [];
  for (const [mode, p] of [
    ['LIGHT', LIGHT],
    ['DARK', DARK],
  ] as const) {
    const svg = (Category: 'FAVICON_SVG' | 'PAGE_HEADER_LOGO' | 'FORM_LOGO', body: string) =>
      assets.push({ Category, ColorMode: mode, Extension: 'SVG', Bytes: Buffer.from(body) });
    svg('FAVICON_SVG', markSvg(p));
    assets.push({ Category: 'FAVICON_ICO', ColorMode: mode, Extension: 'ICO', Bytes: markIco(p) });
    svg('PAGE_HEADER_LOGO', domainLockup(spec.domain.toLowerCase(), p));
    svg('FORM_LOGO', appWordmark(spec.app, p));
  }
  return { settings: SETTINGS, assets };
}

// -------------------------------------------------------------------- colors

/** One color mode, after the console's tokens (services/control-plane/web/src/index.css). */
interface Palette {
  /** Page and form background. */
  page: string;
  fg: string;
  muted: string;
  subtle: string;
  /** Hovered secondary surfaces (`--muted`) and pressed ones (`--accent`). */
  hover: string;
  pressed: string;
  border: string;
  borderStrong: string;
  input: string;
  ring: string;
  link: string;
  linkHover: string;
  /** The primary button: the foreground color, a step lighter (or darker) on hover and press. */
  primaryHover: string;
  primaryPressed: string;
  onPrimary: string;
  ok: string;
  okBg: string;
  warn: string;
  warnBg: string;
  bad: string;
  badBg: string;
}

const LIGHT: Palette = {
  page: '#ffffff',
  fg: '#171717',
  muted: '#5f5f5f',
  subtle: '#737373',
  hover: '#f5f5f5',
  pressed: '#ededed',
  border: '#00000017',
  borderStrong: '#00000029',
  input: '#00000029',
  ring: '#0068d6',
  link: '#0062d1',
  linkHover: '#004ea8',
  primaryHover: '#383838',
  primaryPressed: '#4d4d4d',
  onPrimary: '#ffffff',
  ok: '#297a3a',
  okBg: '#f3faf4',
  warn: '#a35200',
  warnBg: '#fff8ef',
  bad: '#cd2b31',
  badBg: '#fff5f5',
};

const DARK: Palette = {
  page: '#0a0a0a',
  fg: '#ededed',
  muted: '#a1a1a1',
  subtle: '#8a8a8a',
  hover: '#161616',
  pressed: '#1f1f1f',
  border: '#ffffff1a',
  borderStrong: '#ffffff2b',
  input: '#ffffff2e',
  ring: '#52a8ff',
  link: '#52a8ff',
  linkHover: '#8cc4ff',
  primaryHover: '#cccccc',
  primaryPressed: '#b3b3b3',
  onPrimary: '#0a0a0a',
  ok: '#62c073',
  okBg: '#0c1a0f',
  warn: '#f2a20d',
  warnBg: '#1c1405',
  bad: '#ff6166',
  badBg: '#1f0d0e',
};

/** Cognito's form: `rrggbbaa`, no `#`. */
const rgba = (hex: string) => (hex.length === 7 ? `${hex.slice(1)}ff` : hex.slice(1));

const modes = <T>(f: (p: Palette) => T) => ({ lightMode: f(LIGHT), darkMode: f(DARK) });

// ------------------------------------------------------------------ settings

const RADIUS = 6;

/** A bordered control (secondary and identity provider buttons). */
const outlined = (p: Palette) => ({
  defaults: { backgroundColor: rgba(p.page), borderColor: rgba(p.borderStrong), textColor: rgba(p.fg) },
  hover: { backgroundColor: rgba(p.hover), borderColor: rgba(p.borderStrong), textColor: rgba(p.fg) },
  active: { backgroundColor: rgba(p.pressed), borderColor: rgba(p.borderStrong), textColor: rgba(p.fg) },
});

/**
 * An update replaces the whole document, and Cognito fills what it leaves out
 * with its own defaults, so this names everything the look depends on. Its
 * keys come from `DescribeManagedLoginBrandingByClient --return-merged-resources`;
 * Cognito refuses values it doesn't know.
 */
const SETTINGS: Settings = {
  categories: {
    global: {
      colorSchemeMode: 'DYNAMIC',
      pageHeader: { enabled: true },
      pageFooter: { enabled: false },
      spacingDensity: 'REGULAR',
    },
    form: {
      displayGraphics: true,
      location: { horizontal: 'CENTER', vertical: 'CENTER' },
    },
  },
  components: {
    pageBackground: { image: { enabled: false }, ...modes((p) => ({ color: rgba(p.page) })) },
    pageHeader: {
      backgroundImage: { enabled: false },
      logo: { enabled: true, location: 'START' },
      ...modes((p) => ({ background: { color: rgba(p.page) }, borderColor: rgba(p.border) })),
    },
    // No card: the form sits on the page.
    form: {
      borderRadius: 0,
      backgroundImage: { enabled: false },
      logo: { enabled: true, location: 'CENTER', position: 'TOP', formInclusion: 'IN' },
      ...modes((p) => ({ backgroundColor: rgba(p.page), borderColor: `${rgba(p.page).slice(0, 6)}00` })),
    },
    pageText: modes((p) => ({
      headingColor: rgba(p.fg),
      bodyColor: rgba(p.muted),
      descriptionColor: rgba(p.muted),
    })),
    primaryButton: modes((p) => ({
      defaults: { backgroundColor: rgba(p.fg), textColor: rgba(p.onPrimary) },
      hover: { backgroundColor: rgba(p.primaryHover), textColor: rgba(p.onPrimary) },
      active: { backgroundColor: rgba(p.primaryPressed), textColor: rgba(p.onPrimary) },
      disabled: { backgroundColor: rgba(p.pressed), borderColor: rgba(p.pressed) },
    })),
    secondaryButton: modes(outlined),
    idpButton: { standard: modes(outlined) },
    alert: {
      borderRadius: 8,
      ...modes((p) => ({ error: { backgroundColor: rgba(p.badBg), borderColor: rgba(p.bad) } })),
    },
    favicon: { enabledTypes: ['ICO', 'SVG'] },
  },
  componentClasses: {
    buttons: { borderRadius: RADIUS },
    input: {
      borderRadius: RADIUS,
      ...modes((p) => ({
        defaults: { backgroundColor: rgba(p.page), borderColor: rgba(p.input) },
        placeholderColor: rgba(p.subtle),
      })),
    },
    inputLabel: modes((p) => ({ textColor: rgba(p.fg) })),
    inputDescription: modes((p) => ({ textColor: rgba(p.muted) })),
    link: modes((p) => ({ defaults: { textColor: rgba(p.link) }, hover: { textColor: rgba(p.linkHover) } })),
    focusState: modes((p) => ({ borderColor: rgba(p.ring) })),
    optionControls: modes((p) => ({
      defaults: { backgroundColor: rgba(p.page), borderColor: rgba(p.input) },
      selected: { backgroundColor: rgba(p.fg), foregroundColor: rgba(p.onPrimary) },
    })),
    statusIndicator: modes((p) => ({
      success: { backgroundColor: rgba(p.okBg), borderColor: rgba(p.ok), indicatorColor: rgba(p.ok) },
      warning: { backgroundColor: rgba(p.warnBg), borderColor: rgba(p.warn), indicatorColor: rgba(p.warn) },
      error: { backgroundColor: rgba(p.badBg), borderColor: rgba(p.bad), indicatorColor: rgba(p.bad) },
      pending: { indicatorColor: rgba(p.subtle) },
    })),
    divider: modes((p) => ({ borderColor: rgba(p.border) })),
    dropDown: {
      borderRadius: RADIUS,
      ...modes((p) => ({
        defaults: { itemBackgroundColor: rgba(p.page) },
        hover: {
          itemBackgroundColor: rgba(p.hover),
          itemBorderColor: rgba(p.borderStrong),
          itemTextColor: rgba(p.fg),
        },
        match: { itemBackgroundColor: rgba(p.page), itemTextColor: rgba(p.link) },
      })),
    },
    idpButtons: { icons: { enabled: true } },
  },
};

// --------------------------------------------------------------------- logos

const num = (n: number) => String(Math.round(n * 100) / 100);

/** Cognito refuses a logo outside 1:1 to 4:1 (width:height), so pad it, content centered. */
function logo(width: number, height: number, body: string): string {
  let w = width;
  let h = height;
  if (w > 4 * h) h = w / 4;
  if (w < h) w = h;
  const dx = (w - width) / 2;
  const dy = (h - height) / 2;
  const content = dx || dy ? `<g transform="translate(${num(dx)} ${num(dy)})">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}">${content}</svg>`;
}

/**
 * `text` as Geist outlines at `size` px, its baseline at `y` from `x`, with
 * the font's kerning and `tracking` (in em) between letters.
 */
function outlineText(
  text: string,
  opts: { size: number; x: number; y: number; fill: string; tracking: number },
): { svg: string; width: number } {
  const font: GlyphSet = GEIST_SEMIBOLD;
  // App names and domains are ASCII; anything else has no outline and throws below.
  const chars = text.split('');
  let advance = 0;
  const paths: string[] = [];
  for (const [i, ch] of chars.entries()) {
    const glyph = font.glyphs[ch];
    if (!glyph) throw new Error(`no outline for ${JSON.stringify(ch)} in ${JSON.stringify(text)}`);
    paths.push(`<path transform="translate(${advance} 0)" d="${glyph.d}"/>`);
    advance += glyph.advance;
    const next = chars[i + 1];
    if (next) advance += (font.kerning[ch + next] ?? 0) + opts.tracking * font.unitsPerEm;
  }
  const scale = opts.size / font.unitsPerEm;
  return {
    svg: `<g fill="${opts.fill}" transform="translate(${num(opts.x)} ${num(opts.y)}) scale(${scale})">${paths.join('')}</g>`,
    width: advance * scale,
  };
}

/** The platform's mark (the console's favicon): a rounded square with a smaller one inside. */
const MARK = { size: 16, radius: 4, inner: { at: 4.5, size: 7, radius: 1.5 } };

function mark(x: number, size: number, p: Palette): string {
  const k = size / MARK.size;
  const i = MARK.inner;
  return (
    `<rect x="${num(x)}" width="${num(size)}" height="${num(size)}" rx="${num(MARK.radius * k)}" fill="${p.fg}"/>` +
    `<rect x="${num(x + i.at * k)}" y="${num(i.at * k)}" width="${num(i.size * k)}" height="${num(i.size * k)}" rx="${num(i.radius * k)}" fill="${p.page}"/>`
  );
}

const markSvg = (p: Palette) => logo(MARK.size, MARK.size, mark(0, MARK.size, p));

/** The header: the mark, then the platform's domain, centered on the mark. */
function domainLockup(domain: string, p: Palette): string {
  const height = 22;
  const size = 15;
  const x = height + 9;
  const capHeight = (GEIST_SEMIBOLD.capHeight * size) / GEIST_SEMIBOLD.unitsPerEm;
  const text = outlineText(domain, { size, x, y: (height + capHeight) / 2, fill: p.fg, tracking: -0.01 });
  return logo(x + text.width, height, mark(0, height, p) + text.svg);
}

/**
 * The app's name over the form. Cognito scales a form logo to a fixed height
 * (about 58px), so the room around the name sets its size: about 36px here,
 * smaller for names long enough to need padding.
 */
function appWordmark(app: string, p: Palette): string {
  const size = 30;
  const height = size * 1.6;
  const capHeight = (GEIST_SEMIBOLD.capHeight * size) / GEIST_SEMIBOLD.unitsPerEm;
  const text = outlineText(app, { size, x: 0, y: (height + capHeight) / 2, fill: p.fg, tracking: -0.02 });
  return logo(text.width, height, text.svg);
}

// ------------------------------------------------------------------- favicon

/**
 * The mark as an ICO (16, 32 and 48px PNGs) for browsers without SVG
 * favicons, rasterized here so the geometry has one source.
 */
function markIco(p: Palette): Uint8Array {
  const images = [16, 32, 48].map((size) => ({ size, png: png(size, rasterizeMark(size, p)) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [i, { size, png: data }] of images.entries()) {
    const entry = 6 + 16 * i;
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  }
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

function insideRoundedRect(x: number, y: number, at: number, size: number, r: number): boolean {
  if (x < at || y < at || x > at + size || y > at + size) return false;
  const cx = Math.min(Math.max(x, at + r), at + size - r);
  const cy = Math.min(Math.max(y, at + r), at + size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** RGBA pixels, 4x4 samples a pixel. */
function rasterizeMark(size: number, p: Palette): Uint8Array {
  const outer = [...Buffer.from(p.fg.slice(1), 'hex')];
  const inner = [...Buffer.from(p.page.slice(1), 'hex')];
  const out = new Uint8Array(size * size * 4);
  const n = 4;
  const unit = MARK.size / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) * unit;
          const y = (py + (sy + 0.5) / n) * unit;
          const i = MARK.inner;
          const color = insideRoundedRect(x, y, i.at, i.size, i.radius)
            ? inner
            : insideRoundedRect(x, y, 0, MARK.size, MARK.radius)
              ? outer
              : undefined;
          if (!color) continue;
          covered++;
          for (let c = 0; c < 3; c++) sum[c]! += color[c]!;
        }
      }
      const o = (py * size + px) * 4;
      if (!covered) continue;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(sum[c]! / covered);
      out[o + 3] = Math.round((255 * covered) / (n * n));
    }
  }
  return out;
}

function png(size: number, rgbaPixels: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++)
    raw.set(rgbaPixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
