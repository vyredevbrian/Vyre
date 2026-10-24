// Watches VYRE for native USDC sent to the receiving wallet and hands each payment to billing.matchPayment.
// Reads only (no key on this server). A block is trusted once it is `confirmSeconds` old (VYRE makes a block only when a transaction arrives,
// so counting blocks on top would make a payment wait for the next customer). Starts from the current block the first time, and is safe to
// repeat: the ledger takes one credit per transaction hash.
async function rpc(url, method, params, fetchImpl = fetch) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}

module.exports = function watch({ billing, rpcUrl, payTo, chainId, confirmSeconds = 15, maxBlocks = 40, fetchImpl, now = () => Date.now() }) {
  const to = String(payTo).toLowerCase();
  const call = (m, p) => rpc(rpcUrl, m, p, fetchImpl);
  const state = { head: null, cursor: null, lastOk: null, lastError: null };

  async function tick() {
    if (chainId) { const id = parseInt(await call('eth_chainId', []), 16); if (id !== Number(chainId)) throw new Error(`wrong chain ${id}, expected ${chainId}`); }
    billing.expireInvoices();
    const head = parseInt(await call('eth_blockNumber', []), 16);
    state.head = head;
    let cursor = billing.getMeta('cursor');
    if (cursor === null) { billing.setMeta('cursor', head); cursor = head; } // do not credit history from before billing was switched on
    cursor = Number(cursor);
    for (let n = cursor + 1; n <= Math.min(head, cursor + maxBlocks); n++) {
      const block = await call('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
      if (!block) break;
      const age = now() / 1000 - parseInt(block.timestamp, 16);
      if (!(age >= confirmSeconds)) break; // too new (or no usable timestamp): look again next time, never skip it
      for (const t of block.transactions || []) {
        if (!t.to || t.to.toLowerCase() !== to || BigInt(t.value) <= 0n) continue;
        const rc = await call('eth_getTransactionReceipt', [t.hash]);
        if (!rc || rc.status !== '0x1') continue; // a failed transfer moved nothing
        billing.matchPayment({ tx: t.hash.toLowerCase(), block: n, from: t.from, valueWei: BigInt(t.value) });
      }
      billing.setMeta('cursor', n); state.cursor = n;
    }
    state.lastOk = Date.now(); state.lastError = null;
  }
  async function safeTick() { try { await tick(); } catch (e) { state.lastError = String(e.message || e).slice(0, 200); } }

  let timer = null;
  return { tick, safeTick, state, start(ms = 15_000) { safeTick(); timer = setInterval(safeTick, ms); return this; }, stop() { clearInterval(timer); } };
};
