// Billing for Vyre Deploy: accounts, a prepaid balance in USDC on VYRE, and invoices matched to on-chain payments.
// Money is whole nano-USDC (1e-9 USDC): BigInt in code, 64-bit INTEGER in SQLite, with a CHECK that a balance never goes negative.
// There is no floating point anywhere near money. One credit per payment (the transaction hash is unique in the ledger).
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

const NANO = 1_000_000_000n;      // 1 USDC in nano-USDC
const MICRO = 1000n;              // invoices are whole micro-USDC (6 decimals), so any wallet can type the amount
const WEI_PER_NANO = 1_000_000_000n; // native USDC has 18 decimals (the native view, per Arc's docs): 1 nano-USDC = 1e9 wei
const DAY = 24 * 3600 * 1000;

// Decimal string to nano-USDC, at most `dp` decimals; null when it is not a plain amount.
function parseUsdc(s, dp = 9) {
  const m = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(String(s).trim());
  if (!m || (m[2] || '').length > dp) return null;
  return BigInt(m[1]) * NANO + BigInt((m[2] || '').padEnd(9, '0'));
}
// Always exactly six decimals, for an amount someone has to type into a wallet.
const fmt6 = (n) => `${n / NANO}.${((n % NANO) / 1000n).toString().padStart(6, '0')}`;
function fmt(n, dp = 6) {
  const neg = n < 0n, a = neg ? -n : n;
  let frac = (a % NANO).toString().padStart(9, '0').slice(0, dp).replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${a / NANO}.${frac}`;
}

const hashPw = (pw) => { const salt = crypto.randomBytes(16); return `s1$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
function checkPw(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1' || !s || !h) return false;
  const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 32), want = Buffer.from(h, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
const DUMMY = hashPw('not-a-real-password'); // so an unknown email costs the same time as a wrong password

function open(file, cfg = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','customer')), balance_nano INTEGER NOT NULL DEFAULT 0 CHECK(balance_nano >= 0), created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id), ts INTEGER NOT NULL,
      kind TEXT NOT NULL, amount_nano INTEGER NOT NULL, ref TEXT NOT NULL, note TEXT, UNIQUE(kind, ref));
    CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id), amount_nano INTEGER NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','paid','expired')), tx TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_open_amount ON invoices(amount_nano) WHERE status = 'open';
    CREATE TABLE IF NOT EXISTS unmatched(tx TEXT PRIMARY KEY, ts INTEGER NOT NULL, from_addr TEXT, amount_nano INTEGER NOT NULL, block INTEGER);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_owner(app TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id));
    CREATE TABLE IF NOT EXISTS hooks(id TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id), repo TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(account, repo));
    CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, created INTEGER NOT NULL, used_by INTEGER);`);

  const st = (sql) => { const s = db.prepare(sql); s.setReadBigInts(true); return s; };
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));
  const toAcct = (r) => r && { id: Number(r.id), email: r.email, role: r.role, balance: r.balance_nano, created: Number(r.created) };

  const q = {
    byId: st('SELECT * FROM accounts WHERE id = ?'),
    byEmail: st('SELECT * FROM accounts WHERE email = ?'),
    insAcct: st('INSERT INTO accounts(email, pw, role, created) VALUES (?,?,?,?)'),
    insLedger: st('INSERT INTO ledger(account, ts, kind, amount_nano, ref, note) VALUES (?,?,?,?,?,?)'),
    addBal: st('UPDATE accounts SET balance_nano = balance_nano + ? WHERE id = ?'),
    bal: st('SELECT balance_nano FROM accounts WHERE id = ?'),
    ledger: st('SELECT ts, kind, amount_nano, ref, note FROM ledger WHERE account = ? ORDER BY id DESC LIMIT ?'),
    insInv: st('INSERT INTO invoices(id, account, amount_nano, created, expires, status) VALUES (?,?,?,?,?, \'open\')'),
    openInv: st('SELECT * FROM invoices WHERE amount_nano = ? AND status = \'open\''),
    invsOf: st('SELECT id, amount_nano, created, expires, status, tx FROM invoices WHERE account = ? ORDER BY created DESC LIMIT 10'),
    payInv: st('UPDATE invoices SET status = \'paid\', tx = ? WHERE id = ? AND status = \'open\''),
    expire: st('UPDATE invoices SET status = \'expired\' WHERE status = \'open\' AND expires < ?'),
    insUnm: st('INSERT OR IGNORE INTO unmatched(tx, ts, from_addr, amount_nano, block) VALUES (?,?,?,?,?)'),
    unm: st('SELECT tx, ts, from_addr, amount_nano, block FROM unmatched ORDER BY ts DESC LIMIT 50'),
    getMeta: st('SELECT v FROM meta WHERE k = ?'),
    setMeta: st('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    setOwner: st('INSERT OR IGNORE INTO app_owner(app, account) VALUES (?, ?)'),
    ownerOf: st('SELECT account FROM app_owner WHERE app = ?'),
    delOwner: st('DELETE FROM app_owner WHERE app = ?'),
    appsOf: st('SELECT COUNT(*) AS n FROM app_owner WHERE account = ?'),
    hookOf: st('SELECT id, account, repo, secret FROM hooks WHERE account = ? AND repo = ?'),
    hookById: st('SELECT id, account, repo, secret FROM hooks WHERE id = ?'),
    insHook: st('INSERT INTO hooks(id, account, repo, secret, created) VALUES (?,?,?,?,?)'),
    rotHook: st('UPDATE hooks SET secret = ? WHERE id = ?'),
    insInvite: st('INSERT INTO invites(code, created) VALUES (?, ?)'),
    useInvite: st('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL'),
    all: st('SELECT * FROM accounts ORDER BY id'),
    sold: st('SELECT COALESCE(SUM(amount_nano), 0) AS s FROM ledger WHERE kind = \'topup\''),
    owed: st('SELECT COALESCE(SUM(balance_nano), 0) AS s FROM accounts WHERE role = \'customer\''),
  };

  const api = {
    NANO, parseUsdc, fmt, fmt6,
    buildPerMin: cfg.buildPerMinNano ?? 9_333_333n, // see docs/FEATURES.md: Vercel's Standard build machine, $0.014 a minute (checked Oct 2026), one third less

    // ---- accounts ----
    // Returns the account, or null when the email is taken. With `invite` given, the code is used up in the same step (throws 'invite' if it is not valid).
    createAccount(email, password, role = 'customer', invite) {
      const pw = hashPw(password);
      try {
        return tx(() => {
          const r = q.insAcct.run(String(email).toLowerCase(), pw, role, Date.now());
          if (invite !== undefined && q.useInvite.run(r.lastInsertRowid, String(invite)).changes < 1) throw new Error('invite');
          return toAcct(q.byId.get(r.lastInsertRowid));
        });
      } catch (e) { if (isUnique(e)) return null; throw e; }
    },
    login(email, password) {
      const a = q.byEmail.get(String(email).toLowerCase());
      const ok = checkPw(password, a ? a.pw : DUMMY);
      return ok && a ? toAcct(a) : null;
    },
    account: (id) => toAcct(q.byId.get(id)),
    accounts: () => q.all.all().map(toAcct),
    ensureOwner(email) {
      const a = q.byEmail.get(email);
      return a ? toAcct(a) : toAcct(q.byId.get(q.insAcct.run(email, hashPw(crypto.randomBytes(24).toString('hex')), 'owner', Date.now()).lastInsertRowid));
    },
    createInvite() { const code = crypto.randomBytes(7).toString('base64url'); q.insInvite.run(code, Date.now()); return code; },
    useInvite: (code, accountId) => Number(q.useInvite.run(accountId, String(code)).changes) === 1,

    // ---- money ----
    balance: (id) => q.bal.get(id)?.balance_nano ?? 0n,
    credit(account, kind, amount, ref, note = null) {
      if (amount <= 0n) throw new Error('credit must be positive');
      try { return tx(() => { q.insLedger.run(account, Date.now(), kind, amount, String(ref), note); q.addBal.run(amount, account); return true; }); }
      catch (e) { if (isUnique(e)) return false; throw e; } // already credited for this reference
    },
    // Takes up to `want`, never more than the balance. Returns what was charged and what could not be.
    debit(account, kind, want, ref, note = null) {
      return tx(() => {
        const bal = q.bal.get(account).balance_nano, take = want < bal ? want : bal;
        if (take > 0n) { q.insLedger.run(account, Date.now(), kind, -take, String(ref), note); q.addBal.run(-take, account); }
        return { charged: take, short: want - take };
      });
    },
    ledger: (account, limit = 50) => q.ledger.all(account, limit).map((r) => ({ ts: Number(r.ts), kind: r.kind, amount: r.amount_nano, ref: r.ref, note: r.note })),
    buildCost: (seconds) => (BigInt(Math.max(1, Math.ceil(seconds))) * ((api.buildPerMin + 59n) / 60n)),
    minToBuild() { return api.buildPerMin * 5n; }, // a customer needs five minutes of build credit to start one
    canBuild: (a) => a.role === 'owner' || api.balance(a.id) >= api.minToBuild(),

    // ---- invoices and payments ----
    createInvoice(account, baseNano, now = Date.now(), ttl = DAY) {
      if (baseNano % MICRO !== 0n || baseNano <= 0n) throw new Error('amount must be whole micro-USDC');
      api.expireInvoices(now);
      for (let i = 0; i < 60; i++) { // a small unique tag on each open invoice is how a payment finds its owner
        const amount = baseNano + BigInt(1 + crypto.randomInt(0, 9999)) * MICRO, id = crypto.randomBytes(6).toString('hex');
        try { q.insInv.run(id, account, amount, now, now + ttl); return { id, amount, expires: now + ttl }; } catch (e) { if (!isUnique(e)) throw e; }
      }
      throw new Error('too many open invoices, try again shortly');
    },
    expireInvoices: (now = Date.now()) => q.expire.run(now),
    invoices: (account) => q.invsOf.all(account).map((r) => ({ id: r.id, amount: r.amount_nano, created: Number(r.created), expires: Number(r.expires), status: r.status, tx: r.tx })),
    // A native transfer to the receiving wallet. Credits the invoice with exactly that amount, or files it as unmatched.
    matchPayment({ tx: hash, block, from, valueWei, now = Date.now() }) {
      const nano = valueWei / WEI_PER_NANO, exact = valueWei % (WEI_PER_NANO * MICRO) === 0n;
      return tx(() => {
        const inv = exact ? q.openInv.get(nano) : null;
        if (inv && q.payInv.run(hash, inv.id).changes > 0) {
          try { q.insLedger.run(inv.account, now, 'topup', nano, hash, `invoice ${inv.id}`); } catch (e) { if (isUnique(e)) return 'duplicate'; throw e; }
          q.addBal.run(nano, inv.account); return 'credited';
        }
        q.insUnm.run(hash, now, from || null, nano, block ?? null); return 'unmatched';
      });
    },
    unmatched: () => q.unm.all().map((r) => ({ tx: r.tx, ts: Number(r.ts), from: r.from_addr, amount: r.amount_nano, block: r.block == null ? null : Number(r.block) })),
    getMeta: (k) => q.getMeta.get(k)?.v ?? null,
    setMeta: (k, v) => q.setMeta.run(k, String(v)),

    // ---- ownership of apps ----
    setOwner: (app, account) => q.setOwner.run(app, account),
    ownerOf: (app) => { const r = q.ownerOf.get(app); return r ? Number(r.account) : null; },
    removeOwner: (app) => q.delOwner.run(app),
    appCount: (account) => Number(q.appsOf.get(account).n),

    // ---- GitHub webhooks: one per account and repository ("owner/name", lower case) ----
    hookFor(account, repo) {
      const row = q.hookOf.get(account, repo);
      if (row) return { id: row.id, account: Number(row.account), repo: row.repo, secret: row.secret };
      const h = { id: crypto.randomBytes(12).toString('hex'), secret: crypto.randomBytes(32).toString('hex') };
      q.insHook.run(h.id, account, repo, h.secret, Date.now());
      return { id: h.id, account, repo, secret: h.secret };
    },
    hookById: (id) => { const r = q.hookById.get(String(id)); return r ? { id: r.id, account: Number(r.account), repo: r.repo, secret: r.secret } : null; },
    rotateHook(id) { const secret = crypto.randomBytes(32).toString('hex'); q.rotHook.run(secret, String(id)); return secret; },

    summary: () => ({ creditSold: q.sold.get().s, creditOwed: q.owed.get().s, unmatched: q.unm.all().length }),
    close: () => db.close(),
  };
  return api;
}

module.exports = { open, parseUsdc, fmt, fmt6, NANO, MICRO, WEI_PER_NANO };
