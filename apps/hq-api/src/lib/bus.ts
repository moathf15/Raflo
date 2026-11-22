import { EventEmitter } from 'node:events';

/**
 * In-process event bus. Every state change the UI shows (employee status, task status, meeting transcript…)
 * is persisted first and then published here; the SSE stream forwards it to connected browsers.
 */
export interface HqEvent {
  type: string;
  [k: string]: unknown;
}

export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(500);
  }
  emit(ev: HqEvent) {
    this.ee.emit('event', { ...ev, at: new Date().toISOString() });
  }
  on(fn: (ev: HqEvent) => void) {
    this.ee.on('event', fn);
    return () => {
      this.ee.off('event', fn);
    };
  }
}
