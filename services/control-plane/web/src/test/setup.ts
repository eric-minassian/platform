/**
 * jsdom stand-ins for what ui-sdk's popups and the charts need, and `fetch`
 * routed to the demo API in this process, so pages render the demo's data.
 */
import { resolve } from 'node:path';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}
globalThis.__UI_SDK_STRICT__ = true;

HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = function () {};
window.scrollTo = () => {};
Element.prototype.scrollTo = function () {};
Element.prototype.checkVisibility = () => true;
Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.matchMedia ??= (query: string) =>
  Object.assign(new EventTarget(), {
    matches: false,
    media: query,
    onchange: null,
  }) as unknown as MediaQueryList;
document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[popover] { display: block !important }',
  }),
);

// Server code, typechecked with the server's settings: a computed path, so this project doesn't follow it.
const demoModule = resolve(import.meta.dirname, '../../../src/demo/fetch.ts');
const { demoFetch } = (await import(/* @vite-ignore */ demoModule)) as {
  demoFetch: (request: Request) => Promise<Response>;
};
globalThis.fetch = (input, init) =>
  demoFetch(input instanceof Request ? input : new Request(new URL(String(input), location.origin), init));

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);
