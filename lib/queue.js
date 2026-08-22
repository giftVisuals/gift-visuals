// In-memory priority job queue.
//
// Plans map to priority (see config/plans.js): MAX jobs are dequeued before
// PRO, which are dequeued before FREE. Within the same priority, jobs run
// FIFO. This is intentionally simple (no Redis) — swap for a real queue
// (BullMQ/Redis) if concurrent multi-instance processing is needed later;
// the public API (enqueue/getJob) is written so that swap wouldn't touch callers.

const { EventEmitter } = require("events");
const crypto = require("crypto");

class JobQueue extends EventEmitter {
  constructor({ concurrency = 1 } = {}) {
    super();
    this.concurrency = concurrency;
    this.pending = [];
    this.jobs = new Map();
    this.activeCount = 0;
  }

  enqueue({ priority, handler, meta }) {
    const id = crypto.randomUUID();
    const job = {
      id,
      status: "queued",
      priority,
      meta,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: 0,
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    this.pending.push({ id, priority, handler });
    this.pending.sort((a, b) => b.priority - a.priority);
    this._drain();
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  updateProgress(id, progress) {
    const job = this.jobs.get(id);
    if (job) job.progress = Math.max(0, Math.min(100, progress));
  }

  async _drain() {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      const job = this.jobs.get(next.id);
      this.activeCount += 1;
      job.status = "processing";
      job.startedAt = new Date().toISOString();

      Promise.resolve()
        .then(() => next.handler(job))
        .then((result) => {
          job.status = "completed";
          job.result = result;
          job.progress = 100;
        })
        .catch((err) => {
          job.status = "failed";
          job.error = err.userMessage || "We couldn't finish this video. Please try again.";
          job.internalError = err.message;
          // The client only ever sees the friendly message above — this is
          // the one place the real cause reaches the server logs.
          console.error(`[job ${job.id}] failed:`, err.message, err.stderr ? `\n${err.stderr.slice(-2000)}` : "");
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          this.activeCount -= 1;
          this._drain();
        });
    }
  }
}

module.exports = { JobQueue };
