// Audio queue: speech and stings play strictly one at a time, in order.
//
// A job is { label, prepare?, play }. prepare() (synthesis) may run ahead while
// an earlier job is still playing, so the next line is ready the moment the
// current one ends; play() returns a promise that settles when the sound stops
// and receives an AbortSignal so interrupt() can cut it off.

export class AudioQueue {
  constructor({ lookahead = 1, onState = () => {} } = {}) {
    this.jobs = [];
    this.lookahead = lookahead;
    this.onState = onState;
    this.playing = null;
    this.running = false;
    this.generation = 0;
    this.stats = { played: 0, dropped: 0, maxConcurrent: 0 };
    this._live = 0;
  }

  get busy() { return this.running || this.jobs.length > 0; }

  /** Add a job; returns a promise that resolves when it has finished playing (or was dropped). */
  push(job) {
    return new Promise((resolve) => {
      const entry = { ...job, resolve, prepared: null };
      this.jobs.push(entry);
      this.prefetch();
      if (!this.running) void this.drain();
    });
  }

  prefetch() {
    for (const j of this.jobs.slice(0, this.lookahead)) {
      if (j.prepare && !j.prepared) j.prepared = Promise.resolve().then(() => j.prepare()).catch((e) => ({ error: e }));
    }
  }

  async drain() {
    this.running = true;
    const gen = this.generation;
    while (this.jobs.length && gen === this.generation) {
      const job = this.jobs.shift();
      this.prefetch();
      const ctrl = new AbortController();
      this.playing = { job, ctrl };
      this.onState({ state: "playing", label: job.label });
      try {
        const prepared = job.prepare ? await (job.prepared ?? job.prepare()) : undefined;
        if (gen !== this.generation) { job.resolve("dropped"); break; }
        if (prepared && prepared.error) throw prepared.error;
        this._live++;
        this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this._live);
        await job.play(prepared, ctrl.signal);
        this.stats.played++;
        job.resolve("played");
      } catch (e) {
        job.resolve(ctrl.signal.aborted ? "interrupted" : "failed");
      } finally {
        if (this._live > 0 && this.playing?.job === job) this._live--;
        this.playing = null;
      }
    }
    this.running = false;
    this.onState({ state: "idle" });
  }

  /** Stop what is playing and drop everything queued (the user started talking). */
  interrupt() {
    this.generation++;
    for (const j of this.jobs) { j.resolve("dropped"); this.stats.dropped++; }
    this.jobs = [];
    this.playing?.ctrl.abort();
    this.running = false;
  }
}

/** Split into sentences so the first one can play while the next is synthesized. */
export function sentences(text) {
  return (text.match(/[^.!?。！？…]+[.!?。！？…]*["')\]]*\s*/gu) ?? [text]).map((s) => s.trim()).filter(Boolean);
}
