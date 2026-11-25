import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ensureLoginBranding } from '../src/drivers/cognito.ts';
import { type LoginBranding, loginBranding } from '../src/login-branding.ts';
import type { EngineContext, EngineLog } from '../src/util.ts';

const branding = loginBranding({ app: 'encore', domain: 'ericminassian.com' });
const text = (b: LoginBranding, category: string, mode: string) => {
  const asset = b.assets.find((a) => a.Category === category && a.ColorMode === mode);
  if (!asset) throw new Error(`no ${category} ${mode}`);
  return Buffer.from(asset.Bytes).toString();
};
const svgSize = (svg: string) => {
  const m = /<svg[^>]* width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  if (!m) throw new Error(`no size in ${svg.slice(0, 80)}`);
  return { width: Number(m[1]), height: Number(m[2]) };
};

describe('login branding', () => {
  it('has a favicon, header logo and form logo for each color mode', () => {
    expect(branding.assets.map((a) => `${a.Category} ${a.ColorMode} ${a.Extension}`).toSorted()).toEqual([
      'FAVICON_ICO DARK ICO',
      'FAVICON_ICO LIGHT ICO',
      'FAVICON_SVG DARK SVG',
      'FAVICON_SVG LIGHT SVG',
      'FORM_LOGO DARK SVG',
      'FORM_LOGO LIGHT SVG',
      'PAGE_HEADER_LOGO DARK SVG',
      'PAGE_HEADER_LOGO LIGHT SVG',
    ]);
    expect(text(branding, 'FORM_LOGO', 'LIGHT')).toContain('fill="#171717"');
    expect(text(branding, 'FORM_LOGO', 'DARK')).toContain('fill="#ededed"');
  });

  it('keeps every logo within the 1:1 to 4:1 Cognito accepts, for short and long names', () => {
    for (const app of ['abc', 'encore', 'a-thirty-character-app-name-xy']) {
      const b = loginBranding({ app, domain: 'ericminassian.com' });
      for (const category of ['FORM_LOGO', 'PAGE_HEADER_LOGO', 'FAVICON_SVG']) {
        const { width, height } = svgSize(text(b, category, 'LIGHT'));
        expect(width / height, `${category} for ${app}`).toBeGreaterThanOrEqual(1);
        expect(width / height, `${category} for ${app}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('draws names as paths, with nothing outside the SVG elements Cognito allows', () => {
    for (const a of branding.assets.filter((x) => x.Extension === 'SVG')) {
      const elements = new Set(
        [
          ...Buffer.from(a.Bytes)
            .toString()
            .matchAll(/<(\w+)/g),
        ].map((m) => m[1]),
      );
      expect(
        [...elements].every((e) => ['svg', 'g', 'path', 'rect'].includes(e!)),
        [...elements].join(),
      ).toBe(true);
    }
    // One path per letter.
    expect(text(branding, 'FORM_LOGO', 'LIGHT').match(/<path /g)).toHaveLength('encore'.length);
    expect(text(branding, 'PAGE_HEADER_LOGO', 'LIGHT').match(/<path /g)).toHaveLength(
      'ericminassian.com'.length,
    );
  });

  it('lowercases the domain and refuses a character it has no outline for', () => {
    expect(loginBranding({ app: 'encore', domain: 'EricMinassian.com' })).toEqual(branding);
    expect(() => loginBranding({ app: 'Encore', domain: 'ericminassian.com' })).toThrow(
      'no outline for "E" in "Encore"',
    );
  });

  it('is the same every time, so an unchanged style costs nothing', () => {
    expect(loginBranding({ app: 'encore', domain: 'ericminassian.com' })).toEqual(branding);
  });

  it("follows the device's color mode, with a header and no card", () => {
    const s = branding.settings as Record<string, Record<string, Record<string, unknown>>>;
    expect(s.categories?.global).toMatchObject({
      colorSchemeMode: 'DYNAMIC',
      pageHeader: { enabled: true },
      pageFooter: { enabled: false },
    });
    expect(s.components?.pageHeader).toMatchObject({ logo: { enabled: true, location: 'START' } });
    expect(s.components?.form).toMatchObject({
      logo: { enabled: true },
      lightMode: { backgroundColor: 'ffffffff', borderColor: 'ffffff00' },
      darkMode: { backgroundColor: '0a0a0aff', borderColor: '0a0a0a00' },
    });
    expect(s.components?.primaryButton).toMatchObject({
      lightMode: { defaults: { backgroundColor: '171717ff', textColor: 'ffffffff' } },
      darkMode: { defaults: { backgroundColor: 'edededff', textColor: '0a0a0aff' } },
    });
  });

  it("writes every color in Cognito's rrggbbaa form", () => {
    const colors: string[] = [];
    const walk = (v: unknown, key = '') => {
      if (typeof v === 'string' && /colou?r$/i.test(key)) colors.push(v);
      else if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) walk(c, k);
    };
    walk(branding.settings);
    expect(colors.length).toBeGreaterThan(50);
    expect(colors.filter((c) => !/^[0-9a-f]{8}$/.test(c))).toEqual([]);
  });

  it('rasterizes the mark into an ICO of 16, 32 and 48px PNGs', () => {
    const ico = Buffer.from(
      branding.assets.find((a) => a.Category === 'FAVICON_ICO' && a.ColorMode === 'LIGHT')!.Bytes,
    );
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    const images = [0, 1, 2].map((i) => {
      const entry = 6 + 16 * i;
      const offset = ico.readUInt32LE(entry + 12);
      return { size: ico[entry]!, png: ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)) };
    });
    expect(images.map((i) => i.size)).toEqual([16, 32, 48]);
    const { size: px, png } = images[1]!;
    const pixel = decodePng(png, px);
    // Transparent outside the rounded corner, the foreground on the frame, the page color inside.
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(16, 3)).toEqual([0x17, 0x17, 0x17, 255]);
    expect(pixel(16, 16)).toEqual([255, 255, 255, 255]);
  });
});

/** RGBA at (x, y) of an 8-bit RGBA PNG whose rows all use filter 0, as the engine writes them. */
function decodePng(png: Buffer, size: number) {
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.subarray(at + 4, at + 8).toString() === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = size * 4 + 1;
  return (x: number, y: number) => {
    expect(raw[y * stride]).toBe(0);
    const o = y * stride + 1 + x * 4;
    return [...raw.subarray(o, o + 4)];
  };
}

describe('ensureLoginBranding', () => {
  type In = Record<string, unknown>;
  interface Style {
    id: string;
    cognito: boolean;
    settings: unknown;
    assets: Array<{ Category: string; ColorMode: string; Extension: string; Bytes: Uint8Array }>;
  }

  /** A pool with one client, `c1`, and the style it starts with. */
  function fakeCognito(initial?: Partial<Style>) {
    const calls: Array<{ name: string; input: In }> = [];
    const logs: string[] = [];
    let ids = 0;
    // Like Cognito: what comes back is a copy of what was sent, never the same objects.
    const copy = (s: Style): Style => ({
      ...s,
      settings: JSON.parse(JSON.stringify(s.settings ?? null)) as unknown,
      assets: s.assets.map((a) => ({ ...a, Bytes: new Uint8Array(a.Bytes) })),
    });
    let style: Style | undefined = initial
      ? copy({ id: `style-${++ids}`, cognito: false, settings: null, assets: [], ...initial })
      : undefined;
    const fromInput = (i: In, id: string): Style =>
      copy({
        id,
        cognito: Boolean(i.UseCognitoProvidedValues),
        settings: i.Settings ?? null,
        assets: (i.Assets ?? []) as Style['assets'],
      });
    const handlers: Record<string, (i: In) => unknown> = {
      DescribeManagedLoginBrandingByClientCommand: () => {
        if (!style) throw Object.assign(new Error('no style'), { name: 'ResourceNotFoundException' });
        const s = copy(style);
        return {
          ManagedLoginBranding: {
            ManagedLoginBrandingId: s.id,
            UseCognitoProvidedValues: s.cognito,
            ...(s.settings === null ? {} : { Settings: s.settings }),
            Assets: s.assets,
          },
        };
      },
      CreateManagedLoginBrandingCommand: (i) => {
        if (style) throw Object.assign(new Error('exists'), { name: 'ManagedLoginBrandingExistsException' });
        style = fromInput(i, `style-${++ids}`);
        return {};
      },
      UpdateManagedLoginBrandingCommand: (i) => {
        if (!style || i.ManagedLoginBrandingId !== style.id) throw new Error('no such style');
        // Settings are replaced; assets merge by category and color mode.
        const sent = fromInput(i, style.id);
        const key = (a: Style['assets'][number]) => `${a.Category}/${a.ColorMode}`;
        const kept = style.assets.filter((a) => !sent.assets.some((b) => key(a) === key(b)));
        style = { ...sent, assets: [...kept, ...sent.assets] };
        return {};
      },
      DeleteManagedLoginBrandingCommand: (i) => {
        if (!style || i.ManagedLoginBrandingId !== style.id) throw new Error('no such style');
        style = undefined;
        return {};
      },
    };
    const client = {
      send: async (cmd: { constructor: { name: string }; input: In }) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        const handler = handlers[cmd.constructor.name];
        if (!handler) throw new Error(`unexpected ${cmd.constructor.name}`);
        return handler(cmd.input);
      },
    };
    const log: EngineLog = (_level, msg) => logs.push(msg);
    const ctx = {
      clients: { cognito: client },
      region: 'us-east-1',
      target: 'aws',
      log,
      accountId: async () => '123456789012',
    } as unknown as EngineContext;
    const ensure = (b: LoginBranding = branding) =>
      ensureLoginBranding(ctx, { userPoolId: 'pool', clientId: 'c1', name: 'encore--prod', branding: b });
    const writes = () => calls.map((c) => c.name).filter((n) => !n.startsWith('Describe'));
    return { ensure, calls, writes, logs, style: () => style };
  }

  it('creates a style for a client without one', async () => {
    const f = fakeCognito();
    await f.ensure();
    expect(f.writes()).toEqual(['CreateManagedLoginBrandingCommand']);
    expect(f.calls[1]?.input).toMatchObject({
      UserPoolId: 'pool',
      ClientId: 'c1',
      UseCognitoProvidedValues: false,
    });
    expect(f.logs).toEqual(['styled managed login']);
  });

  it('leaves a style that already matches alone', async () => {
    const f = fakeCognito();
    await f.ensure();
    await f.ensure();
    expect(f.writes()).toEqual(['CreateManagedLoginBrandingCommand']);
  });

  it("restyles a client on Cognito's own style in place", async () => {
    const f = fakeCognito({ cognito: true });
    await f.ensure();
    expect(f.writes()).toEqual(['UpdateManagedLoginBrandingCommand']);
    expect(f.calls[1]?.input).toMatchObject({
      ManagedLoginBrandingId: 'style-1',
      UseCognitoProvidedValues: false,
    });
    expect(f.style()).toMatchObject({ id: 'style-1', cognito: false, settings: branding.settings });
    expect(f.logs).toEqual(['restyled managed login']);
  });

  it('updates changed settings or a changed asset', async () => {
    const f = fakeCognito();
    await f.ensure();
    await f.ensure({ ...branding, settings: { categories: { global: { colorSchemeMode: 'LIGHT' } } } });
    await f.ensure(loginBranding({ app: 'encore', domain: 'example.com' }));
    expect(f.writes()).toEqual([
      'CreateManagedLoginBrandingCommand',
      'UpdateManagedLoginBrandingCommand',
      'UpdateManagedLoginBrandingCommand',
    ]);
    expect(f.style()?.settings).toEqual(branding.settings);
  });

  it('recreates a style holding an asset it no longer has, since an update would keep it', async () => {
    const stray = {
      Category: 'PAGE_BACKGROUND',
      ColorMode: 'LIGHT',
      Extension: 'SVG',
      Bytes: Buffer.from('<svg/>'),
    };
    const f = fakeCognito({ settings: branding.settings, assets: [...branding.assets, stray] });
    await f.ensure();
    expect(f.writes()).toEqual(['DeleteManagedLoginBrandingCommand', 'CreateManagedLoginBrandingCommand']);
    expect(f.style()?.assets.map((a) => a.Category)).not.toContain('PAGE_BACKGROUND');
    await f.ensure();
    expect(f.writes()).toHaveLength(2);
  });
});
