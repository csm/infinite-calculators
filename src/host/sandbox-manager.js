// Owns one Worker+Repl per installed calculator and enforces the watchdog
// deadline from the outside (doc/plan.md §5): Worker.terminate() reliably
// kills a worker stuck in a non-yielding loop, verified against a real
// infinite `loop`/`recur`, so a timed-out request terminates and replaces
// just that calculator's worker -- every other installed calculator lives in
// its own worker and is unaffected.
const INSTALL_DEADLINE_MS = 5000;
const CALL_DEADLINE_MS = 2000;

class CalcWorker {
  constructor() {
    this.worker = null;
    this.nextReqId = 0;
    this.pending = new Map();
    this.lastGoodSource = null;
    this._spawn();
  }

  _spawn() {
    this.worker = new Worker('/src/host/sandbox-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => {
      const { reqId, ...rest } = e.data;
      const p = this.pending.get(reqId);
      if (!p) return;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      p.resolve(rest);
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, errors: [{ message: 'sandbox worker error: ' + e.message }] });
      }
      this.pending.clear();
    };
  }

  _respawn() {
    this.worker.terminate();
    this._spawn();
  }

  _send(op, payload, deadlineMs) {
    const reqId = ++this.nextReqId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this._respawn();
        resolve({ ok: false, timedOut: true, errors: [{ message: 'computation too expensive (timed out)' }] });
      }, deadlineMs);
      this.pending.set(reqId, { resolve, timer });
      this.worker.postMessage({ reqId, op, ...payload });
    });
  }

  async _reinstallLastGood() {
    if (this.lastGoodSource) {
      await this._send('install', { source: this.lastGoodSource }, INSTALL_DEADLINE_MS);
    }
  }

  async install(source, deadlineMs = INSTALL_DEADLINE_MS) {
    const result = await this._send('install', { source }, deadlineMs);
    if (result.ok) this.lastGoodSource = source;
    else if (result.timedOut) await this._reinstallLastGood();
    return result;
  }

  async compute(inputs, deadlineMs = CALL_DEADLINE_MS) {
    const result = await this._send('compute', { inputs }, deadlineMs);
    if (result.timedOut) await this._reinstallLastGood();
    return result;
  }

  async logic(inputs, outputs, deadlineMs = CALL_DEADLINE_MS) {
    const result = await this._send('logic', { inputs, outputs }, deadlineMs);
    if (result.timedOut) await this._reinstallLastGood();
    return result;
  }

  dispose() {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.worker.terminate();
  }
}

const workers = new Map();

function workerFor(calcId) {
  let w = workers.get(calcId);
  if (!w) {
    w = new CalcWorker();
    workers.set(calcId, w);
  }
  return w;
}

export const sandbox = {
  install: (calcId, source, deadlineMs) => workerFor(calcId).install(source, deadlineMs),
  compute: (calcId, inputs, deadlineMs) => workerFor(calcId).compute(inputs, deadlineMs),
  logic: (calcId, inputs, outputs, deadlineMs) => workerFor(calcId).logic(inputs, outputs, deadlineMs),
  dispose(calcId) {
    const w = workers.get(calcId);
    if (w) {
      w.dispose();
      workers.delete(calcId);
    }
  },
};
