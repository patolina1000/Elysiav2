// Fila simples em memória com concorrência 1 (processamento FIFO).
// Uso: const q = createQueue(async (job)=>{ ... });
//      q.push({ ... });

function createQueue(workerFn, { concurrency = 1, name = 'default' } = {}) {
  const buf = [];
  let running = 0;

  async function runNext() {
    if (running >= concurrency) return;
    const job = buf.shift();
    if (!job) return;

    running++;
    try {
      await workerFn(job);
    } catch (err) {
      console.error(`[Q:${name}] job error`, { err: String(err && err.stack || err) });
    } finally {
      running--;
      setImmediate(runNext);
    }
  }

  return {
    push(job) {
      buf.push(job);
      setImmediate(runNext);
    },
    size() { return buf.length; },
    pending() { return running; }
  };
}

module.exports = { createQueue };
