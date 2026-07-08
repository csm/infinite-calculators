// Owns one Worker+Repl per installed calculator and enforces the watchdog
// deadline from the outside (doc/plan.md §5): Worker.terminate() reliably
// kills a worker stuck in a non-yielding loop, verified against a real
// infinite `loop`/`recur`, so a timed-out request terminates and replaces
// just that calculator's worker -- every other installed calculator lives in
// its own worker and is unaffected.
//
// These deadlines cover only the op itself: worker boot (wasm init +
// sandbox-bundle eval) is excluded via the ready handshake in _send, since
// every install respawns a fresh worker and boot alone can run into the
// seconds on real hardware. They still need real headroom beyond the
// "legitimate :compute runs in milliseconds" §5 probe: an install evals the
// whole generated form and then smoke-tests it by actually running
// :compute/:logic, and the system prompt *requires* generated loops to
// carry literal iteration caps up to ~1200 -- at this interpreter's
// measured speeds (200ms-1.3s for a render eval, doc/plan.md milestone-3
// polish notes) an honest amortization loop is nowhere near "milliseconds".
// The earlier cut to 2000/1000 was justified by a mobile-Safari-crash
// theory later disproven (the crash was the streaming preview's main-Repl
// churn, since fixed structurally) and was rejecting real, correct
// generated calculators as "computation too expensive"; restored to the §5
// design values. A runaway loop still burns a core for the full deadline
// before Worker.terminate() fires -- the underlying "no fuel metering"
// risk (§5) is unchanged either way.
const INSTALL_DEADLINE_MS = 5000;
const CALL_DEADLINE_MS = 2000;
// Boot gets its own, much looser deadline: it's paid per spawned worker,
// not per op, and a slow device compiling wasm is not a runaway loop.
const BOOT_DEADLINE_MS = 15000;

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
    // Resolved by the worker's boot handshake (sandbox-worker.js posts
    // {ready: true} once wasm init + bundle eval finish, or {ready: false}
    // if boot itself failed). _send awaits this before starting an op's
    // deadline timer, so boot time never counts against the op. The boot
    // deadline here is the backstop for a worker that never reports at all
    // (terminated mid-boot, script failed to load, genuinely wedged).
    this.ready = new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ready: false, error: `sandbox worker failed to boot within ${BOOT_DEADLINE_MS}ms` }),
        BOOT_DEADLINE_MS,
      );
      this._resolveReady = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
    this.worker.onmessage = (e) => {
      if ('ready' in e.data) {
        this._resolveReady(e.data);
        return;
      }
      const { reqId, ...rest } = e.data;
      const p = this.pending.get(reqId);
      if (!p) return;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      p.resolve(rest);
    };
    this.worker.onerror = (e) => {
      this._resolveReady({ ready: false, error: 'sandbox worker error: ' + e.message });
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, errors: [{ message: 'sandbox worker error: ' + e.message }] });
      }
      this.pending.clear();
    };
  }

  _respawn() {
    // Fail any request still pending on the worker being terminated: its
    // reply can never arrive, so leaving it in the map would strand its
    // caller until its deadline timer fired -- and that timer would then
    // _respawn() *again*, killing whatever the fresh worker was busy with
    // (e.g. the install that triggered this respawn in the first place).
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, errors: [{ message: 'sandbox worker was recycled' }] });
    }
    this.pending.clear();
    this.worker.terminate();
    this._spawn();
  }

  async _send(op, payload, deadlineMs) {
    // Wait out the current worker's boot before arming the deadline, so a
    // fresh worker's wasm init/bundle eval is never billed to the op (the
    // "computation too expensive on perfectly fine generated calculators"
    // finding, doc/plan.md milestone-3 notes). Re-awaited in a loop because
    // a concurrent timeout can _respawn() while we wait, swapping in a new
    // worker with its own ready promise -- posting to the new worker before
    // *its* boot finishes would reintroduce the same accounting bug.
    for (;;) {
      const ready = this.ready;
      const state = await ready;
      if (!state.ready) {
        // Boot failure, not op timeout: only respawn if nobody else already
        // has (several ops can be waiting on the same failed boot).
        if (this.ready === ready) this._respawn();
        return { ok: false, errors: [{ message: state.error || 'sandbox worker failed to boot' }] };
      }
      if (this.ready === ready) break;
    }
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
    // Real-world finding: repeated installs into the same long-lived
    // worker (every generation attempt, retry, and manual apply targets
    // the same calc-id, so the same worker/Repl) accumulate memory in the
    // sandbox Repl -- each `(def installed-calc ...)` redefinition doesn't
    // reliably release the previous calculator's closures (doc/plan.md's
    // "namespace teardown in a long-lived sandbox Repl" open question, §13).
    // Over enough iterations in one session this exhausted the wasm
    // module's memory and trapped with "unreachable code should not be
    // executed" -- an OOM abort, not the type-mismatch panic first
    // suspected. Respawning fresh on every install (not just compute/logic,
    // which don't redefine anything and don't need it) guarantees no
    // memory ever carries over between installs; the ~50ms respawn cost
    // (measured in doc/plan.md §5) is paid once per install, not per call.
    this._respawn();
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
