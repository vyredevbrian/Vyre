// Run: node --no-warnings --test dashboard/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), path = require('path'), fs = require('fs');
const billing = require('../billing');
const watch = require('../chainwatch');

const { parseUsdc, fmt, NANO } = billing;
const fresh = () => billing.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-')), 'b.db'));
const WEI = (usdcMicro) => BigInt(usdcMicro) * 10n ** 12n; // micro-USDC to 18-decimal native wei

test('parseUsdc and fmt are exact, never floats', () => {
  assert.equal(parseUsdc('10'), 10n * NANO);
  assert.equal(parseUsdc('0.009333333'), 9_333_333n);
  assert.equal(parseUsdc('1.5'), 1_500_000_000n);
  for (const bad of ['', '-1', '1e3', '1.1234567891', 'abc', '0x10', '1,5', ' ']) assert.equal(parseUsdc(bad), null, bad);
  assert.equal(parseUsdc('10.0000005', 6), null); // more than 6 decimals refused when asked
  assert.equal(fmt(10n * NANO), '10.00');
  assert.equal(fmt(155_556n), '0.000155');
  assert.equal(fmt(-2_500_000_000n), '-2.50');
});

test('accounts: duplicate email, login, wrong password, unknown email', () => {
  const b = fresh();
  const a = b.createAccount('A@Example.com', 'correct horse battery');
  assert.equal(a.role, 'customer'); assert.equal(a.email, 'a@example.com');
  assert.equal(b.createAccount('a@example.com', 'x'.repeat(12)), null);
  assert.equal(b.login('a@example.com', 'correct horse battery').id, a.id);
  assert.equal(b.login('A@EXAMPLE.COM', 'correct horse battery').id, a.id);
  assert.equal(b.login('a@example.com', 'wrong'), null);
  assert.equal(b.login('nobody@example.com', 'wrong'), null);
  assert.equal(b.ensureOwner('owner@vyre.local').role, 'owner');
  assert.equal(b.ensureOwner('owner@vyre.local').id, b.ensureOwner('owner@vyre.local').id);
});

test('credit is once per reference; debit never takes more than the balance', () => {
  const b = fresh(); const a = b.createAccount('a@x.com', 'passwordpassword');
  assert.equal(b.credit(a.id, 'topup', 5n * NANO, '0xaa'), true);
  assert.equal(b.credit(a.id, 'topup', 5n * NANO, '0xaa'), false); // same tx again
  assert.equal(b.balance(a.id), 5n * NANO);
  assert.throws(() => b.credit(a.id, 'topup', 0n, '0xbb'));
  assert.throws(() => b.credit(a.id, 'topup', -1n, '0xbb'));
  assert.deepEqual(b.debit(a.id, 'build', 2n * NANO, 'd1'), { charged: 2n * NANO, short: 0n });
  const r = b.debit(a.id, 'build', 10n * NANO, 'd2'); // wants more than is left
  assert.equal(r.charged, 3n * NANO); assert.equal(r.short, 7n * NANO);
  assert.equal(b.balance(a.id), 0n);
  assert.deepEqual(b.debit(a.id, 'build', 1n, 'd3'), { charged: 0n, short: 1n }); // empty: charges nothing
  assert.equal(b.balance(a.id), 0n);
  assert.equal(b.ledger(a.id).reduce((s, r) => s + r.amount, 0n), 0n); // ledger sums to the balance
});

test('the database itself refuses a negative balance', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-')), 'b.db');
  const b = billing.open(file); const a = b.createAccount('a@x.com', 'passwordpassword'); b.credit(a.id, 'topup', 5n, 't');
  const raw = new (require('node:sqlite').DatabaseSync)(file);
  assert.throws(() => raw.exec(`UPDATE accounts SET balance_nano = balance_nano - 6 WHERE id = ${a.id}`), /CHECK/);
  assert.equal(b.balance(a.id), 5n);
  raw.close();
});

test('build cost rounds up per second and is never zero', () => {
  const b = fresh();
  assert.equal(b.buildCost(0), b.buildCost(1));
  assert.equal(b.buildCost(60), 60n * ((b.buildPerMin + 59n) / 60n));
  assert.ok(b.buildCost(60) >= b.buildPerMin); // a minute never costs less than the listed minute price
  assert.ok(b.buildCost(60) - b.buildPerMin < 60n); // and not more than a few nano over
  assert.equal(b.buildCost(12.2), b.buildCost(13));
});

test('canBuild: owner always, customers need five minutes of credit', () => {
  const b = fresh(); const o = b.ensureOwner('o@x'); const c = b.createAccount('c@x.com', 'passwordpassword');
  assert.equal(b.canBuild(o), true);
  assert.equal(b.canBuild(c), false);
  b.credit(c.id, 'topup', b.minToBuild() - 1n, 't1'); assert.equal(b.canBuild(c), false);
  b.credit(c.id, 'topup', 1n, 't2'); assert.equal(b.canBuild(c), true);
});

test('invoices: unique amounts, whole micro-USDC, expiry', () => {
  const b = fresh(); const a = b.createAccount('a@x.com', 'passwordpassword');
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const inv = b.createInvoice(a.id, 10n * NANO); assert.ok(!seen.has(inv.amount)); seen.add(inv.amount); assert.equal(inv.amount % 1000n, 0n); assert.ok(inv.amount > 10n * NANO && inv.amount <= 10n * NANO + 9999_000n); }
  assert.throws(() => b.createInvoice(a.id, 10n * NANO + 1n)); // not whole micro
  assert.throws(() => b.createInvoice(a.id, 0n));
  const c = b.createAccount('c@x.com', 'passwordpassword');
  const e = b.createInvoice(c.id, 5n * NANO, 1000, 10); // expires 10 ms after creation
  b.expireInvoices(5000);
  assert.equal(b.invoices(c.id).find((i) => i.amount === e.amount).status, 'expired');
});

test('payments: exact amount credits once; everything else is unmatched, nothing is lost or duplicated', () => {
  const b = fresh(); const a = b.createAccount('a@x.com', 'passwordpassword'); const c = b.createAccount('c@x.com', 'passwordpassword');
  const inv = b.createInvoice(a.id, 10n * NANO);
  const micro = inv.amount / 1000n;
  assert.equal(b.matchPayment({ tx: '0x1', block: 5, from: '0xf', valueWei: WEI(micro) }), 'credited');
  assert.equal(b.balance(a.id), inv.amount);
  assert.equal(b.matchPayment({ tx: '0x1', block: 5, from: '0xf', valueWei: WEI(micro) }), 'unmatched'); // same tx replayed: invoice already paid, nothing credited again
  assert.equal(b.balance(a.id), inv.amount);
  assert.equal(b.matchPayment({ tx: '0x2', block: 6, from: '0xf', valueWei: WEI(micro) }), 'unmatched'); // second transfer of the same amount after paying
  assert.equal(b.balance(a.id), inv.amount);
  const inv2 = b.createInvoice(c.id, 10n * NANO);
  assert.equal(b.matchPayment({ tx: '0x3', block: 7, from: '0xf', valueWei: WEI(inv2.amount / 1000n) - 1n }), 'unmatched'); // 1 wei short
  assert.equal(b.matchPayment({ tx: '0x4', block: 7, from: '0xf', valueWei: WEI(inv2.amount / 1000n) + 1n }), 'unmatched'); // 1 wei over (not whole micro)
  assert.equal(b.matchPayment({ tx: '0x5', block: 7, from: '0xf', valueWei: WEI(inv2.amount / 1000n + 1n) }), 'unmatched'); // a micro over
  assert.equal(b.balance(c.id), 0n);
  assert.equal(b.matchPayment({ tx: '0x6', block: 8, from: '0xf', valueWei: WEI(inv2.amount / 1000n) }), 'credited'); // the right one still works
  assert.equal(b.balance(c.id), inv2.amount);
  assert.ok(b.unmatched().some((u) => u.tx === '0x3') && b.unmatched().some((u) => u.tx === '0x5'));
  const owed = b.summary();
  assert.equal(owed.creditSold, inv.amount + inv2.amount); assert.equal(owed.creditOwed, inv.amount + inv2.amount);
});

test('an expired invoice is not paid by a late transfer; it waits for the owner as unmatched', () => {
  const b = fresh(); const a = b.createAccount('a@x.com', 'passwordpassword');
  const inv = b.createInvoice(a.id, 7n * NANO, 1000, 10);
  b.expireInvoices(10_000);
  assert.equal(b.matchPayment({ tx: '0x9', block: 1, from: '0xf', valueWei: WEI(inv.amount / 1000n) }), 'unmatched');
  assert.equal(b.balance(a.id), 0n);
});

// ---- chain watcher against a fake RPC ----
const NOW = 1_800_000_000_000, hex = (n) => '0x' + n.toString(16);
function fakeChain({ chainId = 3045 } = {}) {
  const chain = { head: 100, blocks: {}, receipts: {}, chainId };
  chain.fetch = async (_url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
    if (method === 'eth_chainId') return ok(hex(chain.chainId));
    if (method === 'eth_blockNumber') return ok(hex(chain.head));
    if (method === 'eth_getBlockByNumber') return ok(chain.blocks[parseInt(params[0], 16)] || { timestamp: hex(NOW / 1000 - 1000), transactions: [] });
    if (method === 'eth_getTransactionReceipt') return ok(chain.receipts[params[0]] || { status: '0x1' });
    return { ok: true, status: 200, json: async () => ({ error: { message: 'unsupported ' + method } }) };
  };
  chain.send = (block, hash, to, valueWei, { status = '0x1', age = 1000, from = '0xabc' } = {}) => {
    const b = (chain.blocks[block] ||= { timestamp: hex(Math.floor(NOW / 1000) - age), transactions: [] });
    b.transactions.push({ hash, to, from, value: hex(valueWei) }); chain.receipts[hash] = { status };
  };
  return chain;
}
const PAY = '0x00000000000000000000000000000000000000AA';
const mk = (b, ch, extra = {}) => watch({ billing: b, rpcUrl: 'x', payTo: PAY, chainId: 3045, confirmSeconds: 15, fetchImpl: ch.fetch, now: () => NOW, ...extra });

test('watcher: starts at the current block and does not credit history', async () => {
  const b = fresh(), ch = fakeChain(); const a = b.createAccount('a@x.com', 'passwordpassword'); const inv = b.createInvoice(a.id, 10n * NANO);
  ch.send(90, '0xold', PAY, WEI(inv.amount / 1000n)); // paid before billing was switched on
  await mk(b, ch).tick();
  assert.equal(b.balance(a.id), 0n); assert.equal(b.getMeta('cursor'), '100');
});

test('watcher: a payment is credited once its block is old enough, even if no later block ever comes', async () => {
  const b = fresh(), ch = fakeChain(); const a = b.createAccount('a@x.com', 'passwordpassword'); const inv = b.createInvoice(a.id, 10n * NANO);
  const w = mk(b, ch); await w.tick();
  ch.send(101, '0xa', PAY, WEI(inv.amount / 1000n), { age: 5 }); ch.head = 101;   // 5 seconds old: too new
  await w.tick(); assert.equal(b.balance(a.id), 0n); assert.equal(b.getMeta('cursor'), '100'); // waits, does not skip
  ch.blocks[101].timestamp = hex(Math.floor(NOW / 1000) - 20); await w.tick();    // now 20 seconds old, and still the newest block
  assert.equal(b.balance(a.id), inv.amount); assert.equal(b.getMeta('cursor'), '101');
});

test('watcher: ignores other recipients, failed transfers and a block without a timestamp; stops on the wrong chain', async () => {
  const b = fresh(), ch = fakeChain(); const a = b.createAccount('a@x.com', 'passwordpassword'), c = b.createAccount('c@x.com', 'passwordpassword');
  const ia = b.createInvoice(a.id, 10n * NANO), ic = b.createInvoice(c.id, 20n * NANO);
  const w = mk(b, ch); await w.tick();
  ch.send(101, '0xother', '0x00000000000000000000000000000000000000BB', WEI(ic.amount / 1000n));
  ch.send(101, '0xfail', PAY, WEI(ic.amount / 1000n), { status: '0x0' });
  ch.send(102, '0xa', PAY.toLowerCase(), WEI(ia.amount / 1000n)); ch.head = 102; await w.tick();
  assert.equal(b.balance(a.id), ia.amount); assert.equal(b.balance(c.id), 0n);
  ch.send(103, '0xc', PAY, WEI(ic.amount / 1000n)); delete ch.blocks[103].timestamp; ch.head = 103; await w.tick();  // no usable timestamp: not trusted
  assert.equal(b.balance(c.id), 0n); assert.equal(b.getMeta('cursor'), '102');
  ch.blocks[103].timestamp = hex(Math.floor(NOW / 1000) - 100); await w.tick();
  assert.equal(b.balance(c.id), ic.amount);
  b.setMeta('cursor', 90); await w.tick();                                         // rescanning the same blocks credits nothing twice
  assert.equal(b.balance(a.id), ia.amount); assert.equal(b.balance(c.id), ic.amount);
  ch.chainId = 1; const w2 = mk(b, ch);
  await assert.rejects(w2.tick(), /wrong chain/);
  await w2.safeTick(); assert.match(w2.state.lastError, /wrong chain/);
});

test('watcher: a bad RPC answer is reported, balances unchanged, cursor does not move past unread blocks', async () => {
  const b = fresh(), ch = fakeChain(); const a = b.createAccount('a@x.com', 'passwordpassword'); const inv = b.createInvoice(a.id, 10n * NANO);
  await mk(b, ch).tick();
  ch.send(101, '0xz', PAY, WEI(inv.amount / 1000n)); ch.head = 101;
  const real = ch.fetch; let n = 0;
  const flaky = async (u, o) => { if (JSON.parse(o.body).method === 'eth_getBlockByNumber' && n++ === 0) throw new Error('network down'); return real(u, o); };
  const w2 = mk(b, ch, { fetchImpl: flaky });
  await assert.rejects(w2.tick(), /network down/);
  assert.equal(b.balance(a.id), 0n); assert.equal(b.getMeta('cursor'), '100');
  await w2.tick(); assert.equal(b.balance(a.id), inv.amount); // picks up where it stopped
});

test('apps belong to one account; invites work once', () => {
  const b = fresh(); const a = b.createAccount('a@x.com', 'passwordpassword'), c = b.createAccount('c@x.com', 'passwordpassword');
  b.setOwner('site', a.id); b.setOwner('site', c.id); // second claim ignored
  assert.equal(b.ownerOf('site'), a.id); assert.equal(b.ownerOf('nope'), null); assert.equal(b.appCount(a.id), 1);
  b.removeOwner('site'); assert.equal(b.ownerOf('site'), null);
  const code = b.createInvite();
  assert.equal(b.useInvite(code, a.id), true); assert.equal(b.useInvite(code, c.id), false); assert.equal(b.useInvite('bogus', c.id), false);
});
