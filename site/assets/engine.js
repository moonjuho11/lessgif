// Main-thread side of worker.js: one worker, many jobs, progress callbacks, and cancelling.
export class Engine {
  constructor() {
    this.seq = 0;
    this.jobs = new Map();
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      if (!job) return;
      if (data.progress) return job.onProgress?.(data.progress);
      this.jobs.delete(data.id);
      if (data.error) job.fail(Object.assign(new Error(data.error), { frames: data.frames }));
      else job.ok(data.result);
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.restart(e.message ? `The encoder stopped: ${e.message}` : 'The encoder stopped. The browser may have run out of memory: try a shorter or smaller clip.');
    };
  }

  // Fails every running job (their transferred frames are lost) and starts a fresh worker.
  restart(message, extra = {}) {
    for (const j of this.jobs.values()) j.fail(Object.assign(new Error(message), { lost: true }, extra));
    this.jobs.clear();
    this.worker.terminate();
    this.spawn();
  }

  cancel() {
    this.restart('Cancelled.', { cancelled: true });
  }

  run(type, payload, transfer = [], onProgress) {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.jobs.set(id, { ok, fail, onProgress });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }
}
