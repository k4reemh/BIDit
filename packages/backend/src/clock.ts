/**
 * The server clock is the only clock. Every deadline decision (is the auction
 * over? should this bid extend the timer?) reads `now()` from here, never from
 * the database or the client. Injecting it lets tests drive time deterministically
 * with zero sleeping.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock you control by hand. For tests. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | number = new Date()) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Jump to an absolute time. */
  set(time: Date | number): void {
    this.current = typeof time === 'number' ? time : time.getTime();
  }

  /** Move forward by N milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Move forward by N seconds. */
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}
