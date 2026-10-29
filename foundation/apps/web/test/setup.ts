import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

let mobile = false;

/** Makes `(max-width: 48em)` style queries match (a phone) or not (a desktop). */
export function setMobile(value: boolean): void {
  mobile = value;
}

beforeEach(() => {
  mobile = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: /max-width/.test(query) ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  // jsdom has no font loading API; Mantine's autosizing textarea listens to it.
  Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined } });
  Element.prototype.scrollIntoView = () => undefined;
  window.ResizeObserver = class { observe(): void { /* stub */ } unobserve(): void { /* stub */ } disconnect(): void { /* stub */ } };
});

afterEach(() => { cleanup(); });
