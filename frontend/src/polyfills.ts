// Older iPhones (Alan, 2026-10-19: Russ's estimate wouldn't open). The app is
// built to run on iOS 14+, but three newer built-ins are used by our code or
// libraries; on phones that lack them the page went blank. Imported first in
// main.tsx so it runs before anything else.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    value: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k),
    configurable: true, writable: true,
  });
}

if (typeof g.structuredClone !== "function") {
  g.structuredClone = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
}

if (!(Array.prototype as any).at) {
  Object.defineProperty(Array.prototype, "at", {
    value(this: unknown[], n: number) {
      const i = Math.trunc(n) || 0;
      return this[i < 0 ? this.length + i : i];
    },
    configurable: true, writable: true,
  });
}

export {};
