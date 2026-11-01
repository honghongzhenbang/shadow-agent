import { Worker } from 'node:worker_threads';

export class DatabaseWorkerClient {
  constructor(config, { workerUrl = new URL('./database-worker.js', import.meta.url) } = {}) {
    this.config = config;
    this.workerUrl = workerUrl;
    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
  }

  call(operation, params, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Database request cancelled before dispatch'));
    if (!this.worker) {
      const worker = new Worker(this.workerUrl, { workerData: { config: this.config }, execArgv: [] });
      this.worker = worker;
      const failed = error => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      worker.on('error', failed);
      worker.on('exit', code => failed(new Error(`Database worker exited (${code}); operation outcome may require readback`)));
      worker.on('message', message => {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else request.resolve(message.result);
        if (!this.pending.size) worker.unref();
      });
    }
    const worker = this.worker;
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, params }); }
      catch (error) { this.pending.delete(id); if (!this.pending.size) worker.unref(); reject(error); }
    });
  }

  async close() {
    const worker = this.worker;
    if (worker) await worker.terminate();
  }
}
