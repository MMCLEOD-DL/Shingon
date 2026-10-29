import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/** A controllable EventSource: tests push events and errors into it. */
export class FakeEventSource {
  static all = [];
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; FakeEventSource.all.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  emit(event) { for (const fn of this.listeners.run ?? []) fn({ data: JSON.stringify(event) }); }
  open() { this.onopen?.(); }
  fail() { return this.onerror?.(); }
  close() { this.closed = true; }
}
globalThis.EventSource = FakeEventSource;

afterEach(() => { cleanup(); FakeEventSource.all = []; window.history.replaceState(null, '', '/'); });
