/* Launch by deposit, wagbi's way. Server only.

   This is printer-engine 2.4.0's deposit service (src/launch/deposit.ts, the one brrrr and Pilot run in
   production) ported to wagbi. The chain code is the engine's own, imported unchanged from the vendored
   package: the builders (create_v2 + the first buy into the payout wallet; sweep_creator_fee +
   create_fee_sharing_config + update_fee_shares_v2), the guard that reads every transaction before the
   deposit key signs it, the sealed one-time keys, the write-once deposit store, the send loop and the chain
   read-back. What is wagbi's here:
     1. the fee split is the person's: their payout wallet, wagbi's fixed cut (WAGBI_FEE_BPS, default 1500),
        and up to 6 more wallets they add, 8 in all (what fits one split transaction), summing to 100%. It is pinned in the deposit record when
        the address is made; the guard signs exactly that list; update_fee_shares_v2 locks it on chain.
     2. the coin is a wagbi kit (name, ticker and bio as the person edited them, the logo as it was made).
     3. a live coin is written to wagbi's public store (launches/<kitId>.json), so its page shows the split.
     4. payout is always a pasted wallet (no "the wallet I send from"), and private allocation is refused:
        it isn't built (LAUNCH-SPEC.md, "pump.fun mechanics, verified 2026-11-01").

   Other launchpads (launchpads.js, adapters/*.js, Laith 2026-11-02): the creator keeps ALL the creator fees and
   wagbi takes nothing, so their deposits have no split (one share: the payout wallet, 100%). Their transactions
   are signed through custody.js, which checks each one with its launchpad's own guard; each is built twice (once
   to measure its compute by simulation, then with a fitted limit), and the signed simulation must not take more
   from the deposit than the launch's network costs and first buy (the spend cap). A launchpad may add a "prep"
   transaction before the create (Meteora DBC's per-launch config, Bags' fee-share config).

   create(body)   checks the launch, stores the metadata, makes a fresh deposit key (sealed at once) and
                  answers with the address, the exact amount and a QR code.
   status(id)     what the page polls. `needsRun`: start run(id) after answering.
   askRefund(id)  "send it back" on an underpaid deposit, a few minutes after it was made.
   run(id)        the worker, one at a time per deposit (a lease): claims the launch (write-once), creates
                  the coin with the first buy, sets and locks the split, reads it back from the chain, sends
                  the leftover back. A failed launch sends everything back. Every transaction is recorded
                  before it is sent, so one deposit makes at most one coin.
   cron()         launches funded deposits nobody watches, finishes stuck runs, refunds after 24 h.
   Nothing here logs or returns a secret. */

import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  DEFAULT_DEPOSIT_PARAMS, DEPOSIT_ID_RE, FIRST_BUY_MAX_SOL, FIRST_BUY_MIN_SOL, GuardRefused, LATE_MIN_LAMPORTS, LaunchError,
  MAX_CREATE_TRIES, NAME_MAX, TOTAL_BPS, URI_MAX, asShareholders, assertValidSplit, bad, base58,
  PROGRAMS, decodeComputeBudget, buildMetadata, buildSweepTx, cleanWallet, cleanX, dayOf,
  depositAmounts, fromBase64, metaName, metadataJson, newDepositId, qrDataUrl,
  readTable, sendUntilFinal, sigOf, simulateTx, solText, solanaPayUrl, sweepFee, toBase64, txState,
} from 'printer-engine/launch';
import { badWords, cleanSentence, isHouse } from '../words.js';
import { pumpfun } from './adapters/pumpfun.js';
import { adapterFor, adapterOf, padOf, pickerView, statusOf } from './launchpads.js';
import { cuPriceFor } from './chain.js';
import { BRAND } from '../brand.js';

/** The most wallets in a split (pump.fun's adapter: 8, what fits one split transaction; see adapters/pumpfun.js). */
export const MAX_WALLETS = pumpfun.maxWallets;
export const MAX_EXTRA_WALLETS = MAX_WALLETS - 2;
export const BIO_MAX = 280;
export const KIT_ID_RE = /^[A-Za-z0-9_-]{16}$/;

/** Solana's most compute units per transaction. */
const MAX_CU = 1_400_000;
/** New split attempts one run may make (the coin exists: the split is retried until it lands). */
const SPLIT_TRIES_PER_RUN = 2;
/** Solana's rent floor for a plain account: a transfer may not leave a NEW account below it. */
const RENT_FLOOR_LAMPORTS = 890_880;
/** a run lease outlives its run by this much (the function is certainly stopped by then) */
const LEASE_MARGIN_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const isTransientSim = (error) => !!error && (error.startsWith('simulation call failed') || /BlockhashNotFound|blockhash not found|node is behind|429|Too Many Requests/i.test(error));
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The same transaction with another compute limit (its first instruction is the limit: the engine's compile()). */
export function withComputeLimit(tx, units) {
  const ixs = TransactionMessage.decompile(tx.message).instructions;
  const first = ixs[0];
  if (!first || first.programId.toBase58() !== PROGRAMS.computeBudget || decodeComputeBudget(Uint8Array.from(first.data))?.kind !== 'limit') throw new Error('the transaction does not start with its compute limit');
  ixs[0] = ComputeBudgetProgram.setComputeUnitLimit({ units });
  return new VersionedTransaction(new TransactionMessage({ payerKey: tx.message.staticAccountKeys[0], recentBlockhash: tx.message.recentBlockhash, instructions: ixs }).compileToV0Message());
}

const REFUND_WORDS = {
  asked: null,
  abandoned: "it didn't launch within 24 hours, so the SOL went back.",
  closed: 'launching was switched off before your SOL arrived, so it went back. nothing was launched.',
  kit_taken: 'this coin was already launched from another deposit, so your SOL went back.',
  bad_payout: "the payout wallet can't take the coin's fees, so the SOL went back.",
};
const STILL_LAUNCHING = 'your SOL arrived and the coin is launching. if the launch fails, everything comes back on its own.';

const lastOf = (L, type) => L.events.filter((e) => e.type === type).at(-1);

// ── the request ─────────────────────────────────────────────────────────

function cleanPayout(v, what) {
  try {
    return cleanWallet(v);
  } catch {
    throw bad(`${what} isn't a Solana wallet address. paste a wallet you control (not an exchange).`);
  }
}

/** SOL as lamports: 0, or FIRST_BUY_MIN_SOL to FIRST_BUY_MAX_SOL. */
export function cleanFirstBuy(v) {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return 0;
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw bad('the first buy must be a number of SOL.');
  if (n === 0) return 0;
  if (n < FIRST_BUY_MIN_SOL || n > FIRST_BUY_MAX_SOL) throw bad(`the first buy can be 0, or ${FIRST_BUY_MIN_SOL} to ${FIRST_BUY_MAX_SOL} SOL.`);
  return Math.round(n * 1e9);
}

const wholeBps = (v, what) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > TOTAL_BPS) throw bad(`${what} must be above 0%.`);
  return v;
};

/**
 * The launch request, checked: the words as edited, the payout wallet, the split (wagbi's cut is the
 * server's, never the request's) and the first buy. Throws plain words.
 */
export function cleanLaunchBody(body, s) {
  if (!isObj(body)) throw bad('send the launch as json.');
  const allowed = ['kitId', 'chain', 'launchpad', 'currency', 'type', 'name', 'ticker', 'bio', 'x', 'payout', 'creatorBps', 'wallets', 'firstBuySol', 'options'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw bad(`the launch has a field ${BRAND.name} doesn't know (${k.slice(0, 20)}).`);
  const chain = body.chain ?? 'solana';
  const launchpad = body.launchpad ?? 'pumpfun';
  const currency = body.currency ?? 'SOL';
  const pick = adapterFor(chain, launchpad, currency, s);
  if (!pick.adapter) throw new LaunchError('closed', `not open: ${chain}/${launchpad}/${currency}`, pick.why);
  const ad = pick.adapter;
  const type = body.type ?? 'normal';
  if (type === 'allocation') throw new LaunchError('closed', 'allocation is not built', "private allocation isn't open yet. launch it normally for now.");
  if (type !== 'normal') throw bad('pick a launch type.');
  if (typeof body.kitId !== 'string' || !KIT_ID_RE.test(body.kitId)) throw bad(`that isn't a ${BRAND.name} coin.`);

  const name = cleanSentence(body.name);
  if (!name) throw bad('the coin needs a name.');
  if ([...name].length > NAME_MAX) throw bad(`the name is too long (${NAME_MAX} characters at most).`);
  const ticker = cleanSentence(body.ticker).replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) throw bad('the ticker must be 2 to 10 letters or numbers.');
  if (isHouse(ticker)) throw bad(`that ticker is ${BRAND.name}'s own. pick another.`);
  const bio = cleanSentence(body.bio ?? '');
  if ([...bio].length > BIO_MAX) throw bad(`the bio is too long (${BIO_MAX} characters at most).`);
  if (badWords(`${name} ${ticker} ${bio}`)) throw bad(`${BRAND.name} will not launch those words. change them and try again.`);
  let x;
  try {
    x = cleanX(body.x);
  } catch (e) {
    throw bad(e.userMessage || 'the x link must be an x.com profile.');
  }

  const payout = cleanPayout(body.payout, 'the payout wallet');
  const options = ad.cleanOptions(body.options);
  const firstBuyLamports = cleanFirstBuy(body.firstBuySol);
  const cur = pick.launchpad.currencies.find((c) => c.id === currency);
  if (firstBuyLamports > 0 && !ad.firstBuy) throw bad(`there's no first buy on ${pick.launchpad.name} with ${currency}${cur?.note ? `: ${cur.note}` : '.'}`);
  if (ad.feeModel !== 'split') {
    // the creator keeps all the creator fees here: there is no split, and wagbi takes nothing
    if (Array.isArray(body.wallets) ? body.wallets.length : body.wallets != null) throw bad(`on ${pick.launchpad.name} you keep all the creator fees, so there's no split to add wallets to.`);
    if (body.creatorBps !== undefined && body.creatorBps !== null && body.creatorBps !== TOTAL_BPS) throw bad(`on ${pick.launchpad.name} you keep all the creator fees (100%).`);
    if (s.feeWallet && payout === s.feeWallet) throw bad(`that's ${BRAND.name}'s own fee wallet. use your own wallet.`);
    return { kitId: body.kitId, chain, launchpad, currency, type, name, ticker, bio, x, payout, creatorBps: TOTAL_BPS, wallets: [], firstBuyLamports, options, feeModel: 'creator' };
  }
  const maxWallets = ad.maxWallets;
  const maxExtra = maxWallets - 2;
  const creatorBps = wholeBps(body.creatorBps, 'your share');
  const list = body.wallets ?? [];
  if (!Array.isArray(list)) throw bad('the added wallets must be a list.');
  if (list.length > maxExtra) throw bad(`you can add ${maxExtra} more wallets at most (${maxWallets} in the split, yours and wagbi's included).`);
  const wallets = list.map((w, i) => {
    if (!isObj(w)) throw bad('each added wallet needs an address and a share.');
    for (const k of Object.keys(w)) if (k !== 'address' && k !== 'bps') throw bad('each added wallet needs an address and a share.');
    return { address: cleanPayout(w.address, `wallet ${i + 2}`), bps: wholeBps(w.bps, `wallet ${i + 2}'s share`) };
  });
  const total = creatorBps + s.feeBps + wallets.reduce((a, w) => a + w.bps, 0);
  if (total !== TOTAL_BPS) throw bad(`the split adds up to ${total / 100}%. it must be exactly 100%.`);
  const all = [payout, s.feeWallet, ...wallets.map((w) => w.address)];
  if (all.includes(null) || new Set(all).size !== all.length) {
    if (wallets.some((w) => w.address === s.feeWallet) || payout === s.feeWallet) throw bad(`that's ${BRAND.name}'s own fee wallet. use your own wallets.`);
    throw bad('the same wallet is in the split twice. each wallet can be in it once.');
  }
  return { kitId: body.kitId, chain, launchpad, currency, type, name, ticker, bio, x, payout, creatorBps, wallets, firstBuyLamports, options, feeModel: 'split' };
}

/** The split, in order: the payout wallet, wagbi, then the added wallets. Checked with pump.fun's own rules.
 *  Elsewhere the creator keeps all the creator fees: one share, the payout wallet's, 100%. */
export function sharesOf(b, s) {
  if (b.feeModel === 'creator') return [{ role: 'creator', address: b.payout, bps: TOTAL_BPS }];
  const shares = [
    { role: 'creator', address: b.payout, bps: b.creatorBps },
    { role: 'wagbi', address: s.feeWallet, bps: s.feeBps },
    ...b.wallets.map((w) => ({ role: 'wallet', address: w.address, bps: w.bps })),
  ];
  try {
    assertValidSplit(asShareholders(shares));
  } catch (e) {
    throw bad(`the split isn't one pump.fun takes: ${errText(e)}.`);
  }
  return shares;
}

// ── the service ─────────────────────────────────────────────────────────

/**
 * deps: {
 *   rpc, store (engine DepositStore, or null: not set up), custody (engine Custody, or null),
 *   getKit(kitId) -> wagbi kit json | null, putMeta(name, json, kit) -> public url,
 *   readCoin(kitId) -> public launch record | null, writeCoin(record),
 *   settings (settings.js), checkPublic (engine publicChecker, or null), params, now, log, runMs, timing
 * }
 */
export function createLaunchService(d) {
  const s = d.settings;
  const P = { ...DEFAULT_DEPOSIT_PARAMS, ...d.params };
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const settleMs = d.timing?.settleMs ?? 1_500;
  const marginMs = d.timing?.marginMs ?? 5_000;
  const isoNow = () => new Date(now()).toISOString();
  const devnet = s.cluster === 'devnet';
  const q = devnet ? '?cluster=devnet' : '';
  const links = {
    tx: (sig) => (sig ? `https://solscan.io/tx/${sig}${q}` : null),
    token: (mint) => `https://solscan.io/token/${mint}${q}`,
    account: (a) => `https://solscan.io/account/${a}${q}`,
    pump: (mint) => (devnet ? null : `https://pump.fun/coin/${mint}`),
    coin: (kitId) => `${s.publicSite}/k/${kitId}`,
  };
  /** The launchpad adapter a deposit was made for (deposits from before the picker are pump.fun's on SOL). */
  const adOf = (rec) => adapterOf(rec) ?? pumpfun;
  /** What an adapter gets besides the transaction's own inputs: the network, and Bags' key when it is set. */
  const adCtx = { cluster: s.cluster, bagsKey: d.secrets?.bagsKey ?? null, fetch: d.fetch };
  /** The launchpad's own link for a coin ({ url, label }), and the pump.fun link the page has always had. */
  const padLinks = (rec, mint) => {
    const pad = adOf(rec).links(mint, rec.cluster);
    return { pad, pump: (rec.launchpad ?? 'pumpfun') === 'pumpfun' ? pad?.url ?? null : null };
  };
  /** The deposit amounts for an adapter: its own network costs (pump.fun on SOL: the engine's measured ones). */
  const amountsFor = (ad, firstBuyLamports, options) => depositAmounts(firstBuyLamports, { ...P, networkLamports: ad.networkLamports?.(options) ?? P.networkLamports });
  /** How many transactions a launch on this adapter signs before the return (the priority fee is spread over them). */
  const txCount = (ad) => (ad.buildPrep ? 1 : 0) + 1 + (ad.buildSplit ? 1 : 0);

  // ── open or not ─────────────────────────────────────────────────────
  /** What's missing on this deployment for every launchpad (the page only says "launches open soon"). */
  function missingCommon() {
    const out = [];
    if (s.feeProblem) out.push(s.feeProblem);
    if (!d.custody) out.push('WAGBI_DEPOSIT_MASTER_KEY');
    if (!d.store) out.push('WAGBI_DEPOSITS_READ_WRITE_TOKEN (the private wagbi-deposits store)');
    if (!s.publicSite) out.push('WAGBI_PUBLIC_SITE');
    return out;
  }
  /** Everything missing (for the logs): the common pieces, and wagbi's fee wallet (pump.fun's split needs it). */
  function missing() {
    const out = missingCommon();
    if (!s.feeWallet) out.unshift('WAGBI_FEE_WALLET');
    return out;
  }
  /** Why no launch can start now (null: some can). Plain words. */
  function gate() {
    return missingCommon().length ? 'launches open soon. nothing gets sent or spent.' : null;
  }
  /** Why THIS deposit's launchpad can't launch now (switched off, fee wallet gone, ...), or null. For the logs. */
  function closedFor(rec) {
    const common = missingCommon();
    if (common.length) return common.join(', ');
    const pad = padOf(rec.launchpad ?? 'pumpfun');
    const cur = pad?.currencies.find((c) => c.id === (rec.currency ?? 'SOL'));
    if (!pad || !cur) return 'unknown launchpad';
    const st = statusOf(pad, cur, s);
    return st.status === 'live' ? null : `${pad.id}/${cur.id}: ${st.why}${!s.feeWallet && cur.adapter?.feeModel === 'split' ? ' (WAGBI_FEE_WALLET)' : ''}`;
  }

  function config() {
    const view = pickerView(s);
    const why = gate() ?? (view.launchpads.some((l) => l.status === 'live') ? null : 'launches open soon. nothing gets sent or spent.');
    if (why) log({ evt: 'launch.closed', missing: missing() });
    return {
      open: !why,
      reason: why,
      cluster: s.cluster,
      fee: { bps: s.feeBps, wallet: why || !s.feeWallet ? null : s.feeWallet },
      maxWallets: MAX_WALLETS,
      maxExtraWallets: MAX_EXTRA_WALLETS,
      firstBuy: { minSol: FIRST_BUY_MIN_SOL, maxSol: FIRST_BUY_MAX_SOL },
      params: P,
      allocation: { enabled: false, maxBuyers: s.allocation.maxBuyers, maxPct: s.allocation.maxPct, why: "private allocation isn't open yet." },
      ...view,
      ca: s.ca ?? null,
    };
  }

  // ── the quote ───────────────────────────────────────────────────────
  /** The exact SOL to send for a first buy, and about how much of the supply that buy gets. */
  async function quote(body) {
    const b = isObj(body) ? body : {};
    const ad = adapterFor(b.chain ?? 'solana', b.launchpad ?? 'pumpfun', b.currency ?? 'SOL', s).adapter ?? adapterOf({ launchpad: b.launchpad, currency: b.currency }) ?? pumpfun;
    let options;
    try {
      options = ad.cleanOptions(b.options);
    } catch {
      options = ad.cleanOptions({});
    }
    const lamports = ad.firstBuy ? cleanFirstBuy(b.firstBuySol) : 0;
    const amounts = amountsFor(ad, lamports, options);
    let firstBuy = null;
    if (lamports > 0) {
      try {
        firstBuy = await ad.estimateFirstBuy(d.rpc, lamports, P.slippagePct, { ...adCtx, options });
      } catch (e) {
        log({ evt: 'launch.quote_estimate_failed', error: errText(e) });
      }
    }
    return { amounts, sol: solText(amounts.totalLamports), firstBuy, cluster: s.cluster };
  }

  // ── a deposit as the page shows it ──────────────────────────────────
  async function load(id) {
    if (!d.store || !DEPOSIT_ID_RE.test(id)) return null;
    const rec = await d.store.get(id);
    if (!rec || rec.brand !== s.brand || rec.cluster !== s.cluster) return null;
    const [events, decision] = await Promise.all([d.store.events(id), d.store.decision(id)]);
    return { rec, events, decision };
  }
  const balanceOf = (address) => d.rpc.getBalance(new PublicKey(address), 'confirmed');
  const append = (id, body) => d.store.append(id, body, isoNow());
  const noteOnce = async (L, text) => {
    if (!L.events.some((e) => e.type === 'note' && e.text === text)) await append(L.rec.id, { type: 'note', text });
  };

  function view(L, balance) {
    const { rec, decision } = L;
    const total = rec.amounts.totalLamports;
    const final = lastOf(L, 'final');
    const live = lastOf(L, 'live');
    const failed = lastOf(L, 'failed');
    const landed = lastOf(L, 'create-landed');
    const split = lastOf(L, 'split-landed');
    const claimed = lastOf(L, 'launch-claimed');
    const launching = decision?.decision === 'launch';

    let phase;
    if (final) phase = final.outcome;
    else if (live) phase = 'live';
    else if (launching) phase = failed ? 'refunding' : 'launching';
    else if (decision?.decision === 'refund') phase = 'refunding';
    else if (balance !== null && balance >= total) phase = 'launching';
    else phase = 'waiting';

    const noSplit = rec.feeModel === 'creator';
    const steps = {
      received: launching || phase === 'launching' || phase === 'live' ? 'done' : !decision && (balance ?? 0) > 0 ? 'run' : 'wait',
      create: landed ? 'done' : failed ? 'fail' : phase === 'launching' ? 'run' : 'wait',
      split: noSplit ? 'skip' : split || live ? 'done' : landed && !failed ? 'run' : 'wait',
      live: live ? 'done' : 'wait',
    };
    const returns = L.events.filter((e) => e.type === 'returned').map((e) => ({ what: e.what, lamports: e.lamports, to: e.to, tx: links.tx(e.sig), at: e.at }));
    const refundOpen = !decision && balance !== null && balance > 0 && balance < total && now() >= Date.parse(rec.refundFrom);
    let problem = null;
    if (failed) problem = failed.problem;
    else if (decision?.decision === 'refund') problem = REFUND_WORDS[decision.why] ?? null;

    return {
      id: rec.id,
      kitId: rec.kitId,
      cluster: rec.cluster,
      launchpad: rec.launchpad ?? 'pumpfun',
      launchpadName: padOf(rec.launchpad ?? 'pumpfun')?.name ?? 'pump.fun',
      currency: rec.currency ?? 'SOL',
      feeModel: rec.feeModel ?? 'split',
      options: rec.options ?? {},
      coin: { name: rec.coin.name, ticker: rec.coin.ticker, imageUrl: rec.coin.imageUrl, links: rec.coin.links },
      address: rec.address,
      payUrl: solanaPayUrl(rec.address, total, BRAND.name, `launch $${rec.coin.ticker}`),
      payout: rec.payout.address,
      shares: rec.shares,
      amounts: rec.amounts,
      sol: solText(total),
      received: claimed ? { lamports: claimed.lamports, missingLamports: 0 } : balance === null ? null : { lamports: balance, missingLamports: Math.max(0, total - balance) },
      phase,
      steps,
      launch: landed
        ? { mint: landed.mint, links: { ...padLinks(rec, landed.mint), coin: links.coin(rec.kitId), mint: links.token(landed.mint), createTx: links.tx(landed.sig), splitTx: split ? links.tx(split.sig) : null } }
        : null,
      returns,
      refund: { available: refundOpen, from: decision ? null : rec.refundFrom },
      problem,
      createdAt: rec.createdAt,
      abandonAt: rec.abandonAt,
    };
  }

  // ── create ──────────────────────────────────────────────────────────
  async function create(body) {
    const closed = gate();
    if (closed) {
      log({ evt: 'launch.closed', missing: missing() });
      throw new LaunchError('closed', closed, closed);
    }
    const b = cleanLaunchBody(body, s);
    const shares = sharesOf(b, s);

    // b.kitId is the version on screen; the coin is its conversation (the first kit's id): one coin per conversation
    const kit = await d.getKit(b.kitId);
    if (!kit) throw new LaunchError('not_found', 'no such kit', `this coin isn't on ${BRAND.name}.`);
    const coinId = kit.root || kit.id;
    if (await d.readCoin(coinId)) throw bad('this coin is already launched. make a new one.');
    const lock = await d.store.kitLock(coinId);
    if (lock && !lock.free) throw bad('this coin is launching from another deposit right now. wait for it, or make a new one.');

    const imageUrl = kit.logo;
    const website = links.coin(coinId);
    const json = metadataJson(buildMetadata({ name: b.name, ticker: b.ticker, description: b.bio, imageUrl, site: s.publicSite, x: b.x, telegram: null, website }));
    const uri = await d.putMeta(metaName(json), json, kit);
    if (uri.length > URI_MAX) throw new LaunchError('config', 'metadata uri too long', 'launching isn\'t set up right on this site. nothing was sent.');
    // pump.fun reads these once the coin exists: they must read right from the public internet NOW
    if (d.checkPublic) {
      const problems = await d.checkPublic({ uri, json, imageUrl, website });
      if (problems.length) {
        log({ evt: 'launch.public_check_failed', kitId: coinId, uri, problems });
        throw new LaunchError('config', `the coin's links don't read right: ${problems.join('; ')}`, "the coin's details can't be read publicly yet, so nothing was made. try again in a minute.");
      }
    }

    const amounts = amountsFor(adOf(b), b.firstBuyLamports, b.options);
    const id = newDepositId();
    const { address, sealed } = d.custody.newDepositKey(id);
    const at = now();
    const rec = {
      v: 1, id, brand: s.brand, cluster: s.cluster, chain: b.chain, launchpad: b.launchpad, currency: b.currency, kitId: coinId, versionId: kit.id, version: kit.version || 1, address, kid: sealed.kid,
      payout: { mode: 'address', address: b.payout },
      // pinned now: the split pays exactly these, whatever the environment says later
      shares,
      coin: { name: b.name, ticker: b.ticker, lore: b.bio, imageUrl, uri, takes: { words: 0, logo: 0, banner: 0, site: 0 }, links: { x: b.x, telegram: null, website } },
      type: b.type, feeModel: b.feeModel, options: b.options,
      firstBuyLamports: b.firstBuyLamports, slippagePct: P.slippagePct, priorityLamports: P.priorityLamports, amounts,
      test: devnet,
      createdAt: new Date(at).toISOString(), refundFrom: new Date(at + P.refundAfterMs).toISOString(), abandonAt: new Date(at + P.abandonAfterMs).toISOString(),
    };
    await d.store.create(rec, sealed);
    log({ evt: 'launch.created', id, kitId: coinId, versionId: kit.id, address, launchpad: b.launchpad, currency: b.currency, totalLamports: amounts.totalLamports, firstBuyLamports: b.firstBuyLamports, wallets: shares.length, cluster: s.cluster });
    const v = view({ rec, events: await d.store.events(id), decision: null }, 0);
    v.qr = await qrDataUrl(v.payUrl);
    return v;
  }

  // ── status ──────────────────────────────────────────────────────────
  async function status(id, o = {}) {
    const L = await load(id);
    if (!L) return null;
    const balance = await balanceOf(L.rec.address).catch(() => null);
    const v = view(L, balance);
    let needsRun = false;
    if (lastOf(L, 'final')) needsRun = balance !== null && balance > LATE_MIN_LAMPORTS;
    else if (L.decision) needsRun = true;
    else needsRun = balance !== null && balance >= L.rec.amounts.totalLamports;
    if (!needsRun && !L.decision && now() >= Date.parse(L.rec.abandonAt)) needsRun = true;
    if (needsRun && (await d.store.busy(id, now()))) needsRun = false;
    if (o.qr) v.qr = await qrDataUrl(v.payUrl);
    return { view: v, needsRun };
  }

  // ── "send it back" ──────────────────────────────────────────────────
  async function askRefund(id) {
    const L = await load(id);
    if (!L) throw new LaunchError('not_found', 'no such deposit', `that deposit isn't on ${BRAND.name}.`);
    if (L.decision?.decision === 'launch') throw bad(STILL_LAUNCHING);
    if (!L.decision) {
      const balance = await balanceOf(L.rec.address);
      if (balance >= L.rec.amounts.totalLamports) throw bad(STILL_LAUNCHING);
      if (now() < Date.parse(L.rec.refundFrom)) throw bad(`you can ask for it back from ${new Date(L.rec.refundFrom).toISOString().slice(11, 16)} UTC (a few minutes after the address was made).`);
      const r = await d.store.decide(id, { decision: 'refund', why: 'asked', at: isoNow() });
      if (!r.won && r.decision.decision === 'launch') throw bad(STILL_LAUNCHING);
      log({ evt: 'launch.refund_asked', id, balance });
    }
    return status(id);
  }

  // ── the run ─────────────────────────────────────────────────────────
  async function signerFor(ctx, rec) {
    if (ctx.signer) return ctx.signer;
    if (!d.custody) throw new LaunchError('config', 'WAGBI_DEPOSIT_MASTER_KEY missing', "launching isn't set up on this site.");
    const sealed = await d.store.sealedKey(rec.id);
    if (!sealed) throw new Error(`deposit ${rec.id} has no sealed key`);
    ctx.signer = d.custody.signer(sealed, rec.id, rec.address);
    return ctx.signer;
  }
  async function tableFor(ctx) {
    if (ctx.table === undefined) ctx.table = s.table ? await readTable(d.rpc, s.table) : null;
    return ctx.table;
  }
  const sendDeadline = (ctx) => ctx.deadline - Math.round(marginMs * 0.6);
  const sendOpts = () => ({ resendMs: d.timing?.resendMs, pollMs: d.timing?.pollMs, now });

  async function run(id, o = {}) {
    const start = now();
    const own = d.store && DEPOSIT_ID_RE.test(id) ? await d.store.get(id) : null;
    if (!own || own.brand !== s.brand || own.cluster !== s.cluster) return { ran: false, phase: null, steps: ['no such deposit here'] };
    const deadline = Math.min(o.deadline ?? Number.POSITIVE_INFINITY, start + (d.runMs ?? 100_000));
    const gen = await d.store.takeLease(id, start, deadline + LEASE_MARGIN_MS);
    if (gen === null) return { ran: false, phase: null, steps: ['someone else is working on it'] };
    const ctx = { id, deadline, steps: [], splitTries: 0, verifyTries: 0, signer: null, table: undefined };
    let L = null;
    try {
      for (let i = 0; i < 24 && now() < deadline - marginMs; i++) {
        L = await load(id);
        if (!L) break;
        if ((await advance(L, ctx)) === 'stop') break;
      }
    } catch (e) {
      ctx.steps.push(`stopped: ${errText(e)}`);
      log({ evt: 'launch.run_error', id, error: errText(e) });
    } finally {
      ctx.signer?.retire();
      await d.store.endLease(id, gen).catch(() => undefined);
    }
    const after = await load(id);
    const balance = after ? await balanceOf(after.rec.address).catch(() => null) : null;
    return { ran: true, phase: after ? view(after, balance).phase : null, steps: ctx.steps };
  }

  async function advance(L, ctx) {
    const { rec } = L;
    if (lastOf(L, 'final')) {
      const balance = await balanceOf(rec.address);
      if (balance > LATE_MIN_LAMPORTS) await sendBack(L, ctx, 'late');
      return 'stop';
    }
    if (!L.decision) {
      const balance = await balanceOf(rec.address);
      if (now() >= Date.parse(rec.abandonAt) && balance < rec.amounts.totalLamports) {
        await d.store.decide(rec.id, { decision: 'refund', why: 'abandoned', at: isoNow() });
        return 'again';
      }
      if (balance < rec.amounts.totalLamports) return 'stop';
      return decideLaunch(L, ctx, balance);
    }
    if (L.decision.decision === 'refund') {
      if (!lastOf(L, 'refund-claimed')) await append(rec.id, { type: 'refund-claimed', why: L.decision.why });
      return finish(L, ctx, 'refund');
    }
    if (lastOf(L, 'live')) return finish(L, ctx, 'leftover');
    if (lastOf(L, 'failed')) return finish(L, ctx, 'refund');
    const ad = adOf(rec);
    if (ad.buildPrep && !lastOf(L, 'prep-landed')) return prepStep(L, ctx);
    const landed = lastOf(L, 'create-landed');
    if (!landed) return createStep(L, ctx);
    if (ad.buildSplit && !lastOf(L, 'split-landed')) return splitStep(L, ctx, landed.mint);
    return verifyStep(L, ctx, landed);
  }

  /** The SOL is there: claim the launch (or refuse it, and send it back). */
  async function decideLaunch(L, ctx, balance) {
    const { rec } = L;
    const refuse = async (why, detail) => {
      ctx.steps.push(`refund: ${why}`);
      log({ evt: 'launch.refused', id: rec.id, why, detail });
      await d.store.decide(rec.id, { decision: 'refund', why, at: isoNow() });
      return 'again';
    };
    const payout = rec.payout.address;
    const closed = closedFor(rec);
    if (closed) return refuse('closed', closed);
    if (await d.readCoin(rec.kitId)) return refuse('kit_taken', 'the kit has a coin');
    if (!(await d.store.takeKit(rec.kitId, rec.id))) return refuse('kit_taken', 'another deposit holds the kit');
    const r = await d.store.decide(rec.id, { decision: 'launch', payout, at: isoNow() });
    if (r.won) {
      await append(rec.id, { type: 'launch-claimed', payout, lamports: balance });
      ctx.steps.push('launch claimed');
      log({ evt: 'launch.claimed', id: rec.id, kitId: rec.kitId, lamports: balance });
    } else if (r.decision.decision === 'refund') {
      await d.store.freeKit(rec.kitId, rec.id);
    }
    return 'again';
  }

  async function fail(L, ctx, problem, detail) {
    ctx.steps.push(`failed: ${detail}`);
    log({ evt: 'launch.failed', id: L.rec.id, kitId: L.rec.kitId, detail });
    await append(L.rec.id, { type: 'failed', problem, detail: detail.slice(0, 300) });
    return 'again';
  }

  /** The last recorded transaction of a kind, on chain: landed, dead (can never land) or pending. */
  async function settle(ctx, a) {
    let st = await txState(d.rpc, a.sig, a.lastValidBlockHeight);
    if (st.state === 'pending') {
      const out = await sendUntilFinal(d.rpc, fromBase64(a.wire), a.sig, a.lastValidBlockHeight, sendDeadline(ctx), sendOpts());
      st = { state: out.state, err: out.err };
    }
    if (st.state === 'confirmed') return { state: 'landed', why: null };
    if (st.state === 'pending') return { state: 'pending', why: null };
    return { state: 'dead', why: st.state === 'failed' ? `failed on chain: ${st.err}` : 'expired before it landed' };
  }

  /**
   * A transaction a launchpad adapter builds under its own guard (every launchpad but pump.fun on SOL): built once to
   * measure its compute by simulation, built again with a fitted limit and its share of the priority fee, signed
   * through the guard, then simulated signed under the spend cap (it may not take more from the deposit than the
   * launch's network costs and first buy). Bags' transactions come built from Bags (fixedTx): no rebuild.
   * build(cu, cuPrice, keys) -> { tx, policy, extraSigners, keys, ... }.
   */
  async function guardedTx(L, ctx, build) {
    const { rec } = L;
    const deposit = new PublicKey(rec.address);
    const ad = adOf(rec);
    let built;
    try {
      if (ad.fixedTx) {
        built = await build(undefined, undefined, undefined);
      } else {
        const probe = await build(MAX_CU, 0, undefined);
        const m = await simulateTx(d.rpc, probe.tx, deposit, { signed: false });
        if (!m.ok) {
          if (isTransientSim(m.error)) return { state: 'stop', why: `simulation unavailable: ${m.error}` };
          return { state: 'dead', why: `simulation: ${m.error}`, logs: m.logsTail };
        }
        const units = Math.min(MAX_CU, Math.ceil((m.units || 200_000) * 1.2) + 10_000);
        built = await build(units, cuPriceFor(Math.floor(rec.priorityLamports / txCount(ad)), units), probe.keys);
      }
    } catch (e) {
      if (e?.name === 'TooBig') return { state: 'fail', why: e.message, words: "the coin's name is too long to fit in one transaction" };
      // the launch's own words or the launchpad's setup refused it: no retry will change that, so it fails (and refunds)
      if (e instanceof LaunchError && (e.code === 'bad_input' || e.code === 'config')) return { state: 'fail', why: e.message, words: e.userMessage.replace(/\.$/, '') };
      throw e;
    }
    const signer = await signerFor(ctx, rec);
    try {
      signer.sign(built.tx, built.policy, built.extraSigners ?? []);
    } catch (e) {
      if (e instanceof GuardRefused) return { state: 'fail', why: e.message, words: `${BRAND.name} built something its own rules refused` };
      throw e;
    }
    const before = await balanceOf(rec.address);
    const sim = await simulateTx(d.rpc, built.tx, deposit, { signed: true });
    if (!sim.ok) {
      if (isTransientSim(sim.error)) return { state: 'stop', why: `simulation unavailable: ${sim.error}` };
      return { state: 'dead', why: `simulation: ${sim.error}`, logs: sim.logsTail };
    }
    if (sim.lamportsAfter === null || sim.lamportsAfter === undefined) return { state: 'stop', why: "the simulation didn't say what the deposit holds after" };
    const cap = rec.amounts.networkLamports + rec.amounts.firstBuyMaxLamports;
    if (before - sim.lamportsAfter > cap) return { state: 'dead', why: `spend cap: it would take ${before - sim.lamportsAfter} lamports, over ${cap}` };
    return { state: 'ready', built, units: sim.units };
  }

  /** Records a signed transaction BEFORE it is sent (a run that dies after this re-sends these bytes), then sends it. */
  async function recordAndSend(L, ctx, kind, n, tx, lastValidBlockHeight, extra = {}) {
    const wire = tx.serialize();
    const a = { kind, n, sig: sigOf(tx), wire: toBase64(wire), lastValidBlockHeight, at: isoNow(), ...extra };
    if (!(await d.store.putAttempt(L.rec.id, a))) return 'again';
    await append(L.rec.id, { type: `${kind}-sent`, attempt: a.n, sig: a.sig, ...(extra.mint ? { mint: extra.mint } : {}) });
    ctx.steps.push(`${kind} ${a.n} sent ${a.sig}`);
    log({ evt: `launch.${kind}_sent`, id: L.rec.id, attempt: a.n, sig: a.sig, mint: extra.mint });
    const out = await sendUntilFinal(d.rpc, wire, a.sig, a.lastValidBlockHeight, sendDeadline(ctx), sendOpts());
    return out.state === 'pending' ? 'stop' : 'again';
  }

  /** A launchpad's transaction before the create (Meteora DBC's own config, Bags' fee-share config). */
  async function prepStep(L, ctx) {
    const { rec } = L;
    const ad = adOf(rec);
    const atts = await d.store.attempts(rec.id, 'prep');
    const last = atts.at(-1);
    const dead = new Set(L.events.filter((e) => e.type === 'prep-dead').map((e) => e.attempt));
    if (last && !dead.has(last.n)) {
      const r = await settle(ctx, last);
      if (r.state === 'pending') return 'stop';
      const there = r.state === 'landed' ? true : await ad.prepExists(d.rpc, last.data);
      if (there) {
        await append(rec.id, { type: 'prep-landed', sig: last.sig, data: last.data });
        ctx.steps.push(`prep landed ${last.sig}`);
        return 'again';
      }
      await append(rec.id, { type: 'prep-dead', attempt: last.n, sig: last.sig, why: r.why });
      ctx.steps.push(`prep ${last.n} dead: ${r.why}`);
      return 'again';
    }
    const tries = atts.length + L.events.filter((e) => e.type === 'prep-dead' && e.sig === null).length;
    const pad = padOf(rec.launchpad)?.name ?? 'the launchpad';
    if (tries >= MAX_CREATE_TRIES) {
      const why = L.events.filter((e) => e.type === 'prep-dead').at(-1)?.why ?? 'unknown';
      return fail(L, ctx, `${pad} didn't accept the coin's setup, so nothing was launched and your SOL is on its way back.`, `prep failed ${tries} times: ${why}`);
    }
    const closed = !atts.length && closedFor(rec);
    if (closed) return fail(L, ctx, 'launching was switched off before your coin was made, so your SOL is on its way back.', `closed: ${closed}`);
    const recent = await d.rpc.getLatestBlockhash('confirmed');
    const g = await guardedTx(L, ctx, (cu, cuPrice, keys) => ad.buildPrep({
      rpc: d.rpc, cluster: rec.cluster, deposit: rec.address, payout: rec.payout.address, coin: rec.coin, options: rec.options ?? {}, cu, cuPrice, blockhash: recent.blockhash, keys, ctx: adCtx,
    }));
    if (g.state === 'stop') {
      ctx.steps.push(`prep: ${g.why}`);
      return 'stop';
    }
    if (g.state === 'fail') return fail(L, ctx, `${g.words}, so nothing was launched and your SOL is on its way back.`, g.why);
    if (g.state === 'dead') {
      log({ evt: 'launch.prep_sim_failed', id: rec.id, error: g.why, logs: g.logs });
      await append(rec.id, { type: 'prep-dead', attempt: 0, sig: null, why: g.why.slice(0, 300) });
      ctx.steps.push(`prep failed: ${g.why}`);
      return 'again';
    }
    return recordAndSend(L, ctx, 'prep', atts.length + 1, g.built.tx, recent.lastValidBlockHeight, { data: g.built.data });
  }

  async function createStep(L, ctx) {
    const { rec } = L;
    const payout = rec.payout.address;
    const ad = adOf(rec);
    const prep = lastOf(L, 'prep-landed')?.data ?? null;
    const atts = await d.store.attempts(rec.id, 'create');
    const last = atts.at(-1);
    const dead = new Set(L.events.filter((e) => e.type === 'create-dead').map((e) => e.attempt));
    if (last && !dead.has(last.n)) {
      const r = await settle(ctx, last);
      if (r.state === 'pending') return 'stop';
      // a landed create always makes its coin; the coin's account for OUR mint means our create landed
      const curve = r.state === 'landed' ? true : await ad.coinExists(d.rpc, last.mint, { cluster: rec.cluster, payout, prep });
      if (curve) {
        await append(rec.id, { type: 'create-landed', sig: last.sig, mint: last.mint });
        ctx.steps.push(`create landed ${last.sig}`);
        log({ evt: 'launch.create_landed', id: rec.id, mint: last.mint, sig: last.sig });
        return 'again';
      }
      await append(rec.id, { type: 'create-dead', attempt: last.n, sig: last.sig, why: r.why });
      ctx.steps.push(`create ${last.n} dead: ${r.why}`);
      return 'again';
    }
    const pad = padOf(rec.launchpad ?? 'pumpfun')?.name ?? 'pump.fun';
    const tries = atts.length + L.events.filter((e) => e.type === 'create-dead' && e.sig === null).length;
    if (tries >= MAX_CREATE_TRIES) {
      const why = L.events.filter((e) => e.type === 'create-dead').at(-1)?.why ?? 'unknown';
      return fail(L, ctx, `${pad} didn't accept the coin, so nothing was launched and your SOL is on its way back.`, `create failed ${tries} times: ${why}`);
    }
    // the switch, once more, before the first SOL is spent
    const closed = !atts.length && !prep && closedFor(rec);
    if (closed) return fail(L, ctx, 'launching was switched off before your coin was made, so your SOL is on its way back.', `closed: ${closed}`);

    const firstBuy = rec.firstBuyLamports > 0 ? { lamports: BigInt(rec.firstBuyLamports), slippagePct: rec.slippagePct } : null;
    if (adOf(rec).guard) {
      const recent = await d.rpc.getLatestBlockhash('confirmed');
      const g = await guardedTx(L, ctx, (cu, cuPrice, keys) => ad.buildCreate({
        rpc: d.rpc, cluster: rec.cluster, deposit: rec.address, payout, name: rec.coin.name, symbol: rec.coin.ticker, uri: rec.coin.uri, coin: rec.coin,
        firstBuy, maxFirstBuyLamports: rec.amounts.firstBuyMaxLamports, cu, cuPrice, blockhash: recent.blockhash, options: rec.options ?? {}, prep, keys, ctx: adCtx,
      }));
      if (g.state === 'stop') {
        ctx.steps.push(`create: ${g.why}`);
        return 'stop';
      }
      if (g.state === 'fail') return fail(L, ctx, `${g.words}, so nothing was launched and your SOL is on its way back.`, g.why);
      if (g.state === 'dead') {
        log({ evt: 'launch.create_sim_failed', id: rec.id, error: g.why, logs: g.logs });
        await append(rec.id, { type: 'create-dead', attempt: 0, sig: null, why: g.why.slice(0, 300) });
        ctx.steps.push(`create simulation failed: ${g.why}`);
        return 'again';
      }
      return recordAndSend(L, ctx, 'create', atts.length + 1, g.built.tx, recent.lastValidBlockHeight, { mint: g.built.mint });
    }

    // pump.fun on SOL: printer-engine's builders and guard, as proven on devnet 2026-11-01
    const [recent, table] = await Promise.all([d.rpc.getLatestBlockhash('confirmed'), tableFor(ctx)]);
    const deposit = new PublicKey(rec.address);
    let built;
    try {
      built = await ad.buildCreate({
        rpc: d.rpc, deposit: rec.address, payout, name: rec.coin.name, symbol: rec.coin.ticker, uri: rec.coin.uri,
        firstBuy, maxFirstBuyLamports: rec.amounts.firstBuyMaxLamports, priorityLamports: rec.priorityLamports, blockhash: recent.blockhash, table,
      });
    } catch (e) {
      if (e?.name === 'TooBig') return fail(L, ctx, "the coin's name is too long to fit in one transaction, so nothing was launched and your SOL is on its way back.", e.message);
      throw e;
    }
    const tx = built.tx;
    const signer = await signerFor(ctx, rec);
    try {
      signer.sign(tx, built.policy, built.extraSigners);
    } catch (e) {
      if (e instanceof GuardRefused) return fail(L, ctx, `${BRAND.name} built something its own rules refused, so nothing was launched and your SOL is on its way back.`, e.message);
      throw e;
    }
    const sim = await simulateTx(d.rpc, tx, deposit, { signed: true });
    if (!sim.ok) {
      if (isTransientSim(sim.error)) {
        ctx.steps.push(`create simulation unavailable: ${sim.error}`);
        return 'stop';
      }
      log({ evt: 'launch.create_sim_failed', id: rec.id, error: sim.error, logs: sim.logsTail });
      await append(rec.id, { type: 'create-dead', attempt: 0, sig: null, why: `simulation: ${sim.error}`.slice(0, 300) });
      ctx.steps.push(`create simulation failed: ${sim.error}`);
      return 'again';
    }
    log({ evt: 'launch.create_sim', id: rec.id, simUnits: sim.units });
    return recordAndSend(L, ctx, 'create', atts.length + 1, tx, recent.lastValidBlockHeight, { mint: built.mint });
  }

  async function splitStep(L, ctx, mint) {
    const { rec } = L;
    const payout = rec.payout.address;
    const atts = await d.store.attempts(rec.id, 'split');
    const last = atts.at(-1);
    const dead = new Set(L.events.filter((e) => e.type === 'split-dead').map((e) => e.attempt));
    if (last && !dead.has(last.n)) {
      const r = await settle(ctx, last);
      if (r.state === 'pending') return 'stop';
      if (r.state === 'landed') {
        await append(rec.id, { type: 'split-landed', sig: last.sig });
        ctx.steps.push(`split landed ${last.sig}`);
        return 'again';
      }
      await append(rec.id, { type: 'split-dead', attempt: last.n, sig: last.sig, why: r.why });
      ctx.steps.push(`split ${last.n} dead: ${r.why}`);
      return 'again';
    }
    // the coin is on chain; is its split already there (a landing we didn't record)?
    const ad = adOf(rec);
    const v = await ad.readLaunch(d.rpc, { mint, deposit: rec.address, shares: rec.shares, rec });
    if (v.state === 'live') {
      await append(rec.id, { type: 'split-landed', sig: last?.sig ?? '' });
      return 'again';
    }
    if (v.state === 'waiting') {
      if (++ctx.verifyTries > 6) return 'stop';
      await sleep(settleMs);
      return 'again';
    }
    if (v.state === 'rejected') {
      log({ evt: 'launch.chain_mismatch', id: rec.id, mint, problem: v.problem });
      await noteOnce(L, `the coin on chain isn't what was built: ${v.problem}`);
      return 'stop';
    }
    if (v.curve.complete) {
      log({ evt: 'launch.graduated_before_split', id: rec.id, mint });
      await noteOnce(L, 'the coin graduated before its split was set; the split needs the pool account (by hand)');
      return 'stop';
    }
    if (++ctx.splitTries > SPLIT_TRIES_PER_RUN) return 'stop';
    if (ad.guard) {
      const recent = await d.rpc.getLatestBlockhash('confirmed');
      const g = await guardedTx(L, ctx, (cu, cuPrice) => ad.buildSplit({ cluster: rec.cluster, mint, deposit: rec.address, payout, shares: rec.shares, cu, cuPrice, blockhash: recent.blockhash }));
      if (g.state !== 'ready') {
        log({ evt: 'launch.split_sim_failed', id: rec.id, error: g.why, logs: g.logs });
        ctx.steps.push(`split not sent: ${g.why}`);
        return 'stop';
      }
      return recordAndSend(L, ctx, 'split', atts.length + 1, g.built.tx, recent.lastValidBlockHeight);
    }
    const recent = await d.rpc.getLatestBlockhash('confirmed');
    const built = await ad.buildSplit({ mint, deposit: rec.address, payout, shares: rec.shares, priorityLamports: rec.priorityLamports, withBuy: rec.firstBuyLamports > 0, blockhash: recent.blockhash });
    // The engine's split limit (215,000) is too low for some coins: the split's PDA lookups cost more for some
    // mints, and one devnet coin's split needed 219,903 (2026-11-01), so it could never land and the coin sat
    // without its split. A coin's mint is fixed by then, so measure THIS split and give it room.
    const probe = await simulateTx(d.rpc, withComputeLimit(built.tx, MAX_CU), new PublicKey(rec.address), { signed: false });
    if (probe.ok && probe.units) built.tx = withComputeLimit(built.tx, Math.min(MAX_CU, Math.ceil(probe.units * 1.2) + 10_000));
    const signer = await signerFor(ctx, rec);
    signer.sign(built.tx, built.policy);
    const sim = await simulateTx(d.rpc, built.tx, new PublicKey(rec.address), { signed: true });
    if (!sim.ok) {
      log({ evt: 'launch.split_sim_failed', id: rec.id, error: sim.error, logs: sim.logsTail });
      ctx.steps.push(`split simulation failed: ${sim.error}`);
      return 'stop';
    }
    return recordAndSend(L, ctx, 'split', atts.length + 1, built.tx, recent.lastValidBlockHeight);
  }

  /** The chain says live (and, with a split, locked): the coin's public record (its page shows the fees from it). */
  async function verifyStep(L, ctx, landed) {
    const { rec } = L;
    const prep = lastOf(L, 'prep-landed')?.data ?? null;
    const v = await adOf(rec).readLaunch(d.rpc, { mint: landed.mint, deposit: rec.address, shares: rec.shares, rec, prep });
    if (v.state !== 'live') {
      if (v.state === 'rejected') {
        log({ evt: 'launch.chain_mismatch', id: rec.id, mint: landed.mint, problem: v.problem });
        await noteOnce(L, `the coin on chain isn't what was built: ${v.problem}`);
        return 'stop';
      }
      if (++ctx.verifyTries > 6) return 'stop';
      await sleep(settleMs);
      return 'again';
    }
    const splitSig = lastOf(L, 'split-landed')?.sig || null;
    const create = (await d.store.attempts(rec.id, 'create')).find((a) => a.sig === landed.sig);
    let mintSig = '';
    if (create) {
      const tx = VersionedTransaction.deserialize(fromBase64(create.wire));
      const i = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === landed.mint);
      if (i >= 0) mintSig = base58(tx.signatures[i]);
    }
    const feeModel = rec.feeModel ?? 'split';
    if (!(await d.readCoin(rec.kitId))) {
      await d.writeCoin({
        v: 1, kitId: rec.kitId, cluster: rec.cluster, chain: rec.chain ?? 'solana', launchpad: rec.launchpad ?? 'pumpfun', currency: rec.currency ?? 'SOL', versionId: rec.versionId ?? rec.kitId, version: rec.version ?? 1, mint: landed.mint, name: rec.coin.name, ticker: rec.coin.ticker, bio: rec.coin.lore,
        image: rec.coin.imageUrl, uri: rec.coin.uri, x: rec.coin.links.x, payout: rec.payout.address,
        feeModel, split: rec.shares.map((x) => ({ role: x.role, address: x.address, bps: x.bps })), splitLocked: feeModel === 'split', options: rec.options ?? {}, ...(prep ? { setup: prep } : {}),
        allocation: [], firstBuyLamports: rec.firstBuyLamports, createTx: landed.sig, splitTx: splitSig, mintSig, launchedAt: landed.at,
      });
    }
    await append(rec.id, { type: 'live', mint: landed.mint, createSig: landed.sig, splitSig });
    ctx.steps.push(`live ${landed.mint}`);
    log({ evt: 'launch.live', id: rec.id, kitId: rec.kitId, mint: landed.mint, launchpad: rec.launchpad ?? 'pumpfun' });
    return 'again';
  }

  /** Sends everything the deposit holds (less the transfer's own fee) back to the payout wallet. */
  async function sendBack(L, ctx, what) {
    const { rec } = L;
    const atts = await d.store.attempts(rec.id, 'return');
    const last = atts.at(-1);
    const closed = new Set(L.events.filter((e) => e.type === 'returned' || e.type === 'return-dead').map((e) => e.n));
    if (last && !closed.has(last.n)) {
      const r = await settle(ctx, last);
      if (r.state === 'pending') return 'pending';
      if (r.state === 'landed') {
        await append(rec.id, { type: 'returned', what: last.what ?? what, n: last.n, sig: last.sig, lamports: last.lamports ?? 0, to: last.to ?? '' });
        ctx.steps.push(`returned ${last.lamports} to ${last.to}`);
        log({ evt: 'launch.returned', id: rec.id, what: last.what, lamports: last.lamports, sig: last.sig });
        return 'sent';
      }
      await append(rec.id, { type: 'return-dead', n: last.n, sig: last.sig, why: r.why });
    }
    const balance = await balanceOf(rec.address);
    const fee = sweepFee();
    if (balance <= fee) return 'nothing';
    const to = rec.payout.address;
    const lamports = balance - fee;
    const toInfo = await d.rpc.getAccountInfo(new PublicKey(to), 'confirmed');
    if (!toInfo && lamports < RENT_FLOOR_LAMPORTS) {
      await append(rec.id, { type: 'note', text: `${lamports} lamports left: too little to open the payout wallet's account, so they stay` });
      return 'nothing';
    }
    const recent = await d.rpc.getLatestBlockhash('confirmed');
    const tx = buildSweepTx({ deposit: new PublicKey(rec.address), to: new PublicKey(to), lamports, blockhash: recent.blockhash });
    const signer = await signerFor(ctx, rec);
    signer.sign(tx, { kind: 'sweep', payout: to, maxSweepLamports: balance });
    const sim = await simulateTx(d.rpc, tx, new PublicKey(rec.address), { signed: true });
    if (!sim.ok) {
      log({ evt: 'launch.return_sim_failed', id: rec.id, error: sim.error });
      ctx.steps.push(`return simulation failed: ${sim.error}`);
      return 'pending';
    }
    const wire = tx.serialize();
    const a = { kind: 'return', n: atts.length + 1, sig: sigOf(tx), wire: toBase64(wire), lastValidBlockHeight: recent.lastValidBlockHeight, lamports, to, what, at: isoNow() };
    if (!(await d.store.putAttempt(rec.id, a))) return 'pending';
    await append(rec.id, { type: 'return-sent', what, n: a.n, sig: a.sig, lamports, to });
    ctx.steps.push(`return ${a.n} sent: ${solText(lamports)} SOL to ${to}`);
    const out = await sendUntilFinal(d.rpc, wire, a.sig, a.lastValidBlockHeight, sendDeadline(ctx), sendOpts());
    if (out.state === 'confirmed') {
      await append(rec.id, { type: 'returned', what, n: a.n, sig: a.sig, lamports, to });
      log({ evt: 'launch.returned', id: rec.id, what, lamports, sig: a.sig });
      return 'sent';
    }
    if (out.state !== 'pending') await append(rec.id, { type: 'return-dead', n: a.n, sig: a.sig, why: out.err ?? out.state });
    return 'pending';
  }

  /** Sends what's left back, then finishes the deposit (and frees the kit if no coin was made). */
  async function finish(L, ctx, what) {
    const r = await sendBack(L, ctx, what);
    if (r === 'pending') return 'stop';
    const after = await load(L.rec.id);
    const returned = after.events.some((e) => e.type === 'returned');
    const outcome = what === 'leftover' ? 'live' : returned ? 'refunded' : 'expired';
    await append(L.rec.id, { type: 'final', outcome });
    await d.store.markDone(L.rec);
    if (what === 'refund' && !lastOf(after, 'create-landed')) await d.store.freeKit(L.rec.kitId, L.rec.id);
    ctx.steps.push(`final: ${outcome}`);
    log({ evt: 'launch.final', id: L.rec.id, outcome });
    return 'stop';
  }

  // ── the cron ────────────────────────────────────────────────────────
  async function cron(o = {}) {
    const start = now();
    const deadline = o.deadline ?? start + 240_000;
    const report = { at: new Date(start).toISOString(), checked: 0, ran: 0, abandoned: 0, late: 0, errors: [] };
    if (!d.store) return report;
    const days = Array.from({ length: o.days ?? 7 }, (_, i) => dayOf(new Date(start - i * 86_400_000).toISOString()));
    const all = await d.store.byDay(days);
    const stop = deadline - 4 * marginMs;
    for (const item of all.filter((x) => !x.done)) {
      if (now() > stop) break;
      report.checked++;
      try {
        const L = await load(item.id);
        if (!L) continue;
        if (!L.decision && now() >= Date.parse(L.rec.abandonAt)) {
          const r = await d.store.decide(item.id, { decision: 'refund', why: 'abandoned', at: isoNow() });
          if (r.won) report.abandoned++;
        }
        const st = await status(item.id);
        if (st?.needsRun) {
          const r = await run(item.id, { deadline });
          if (r.ran) report.ran++;
        }
      } catch (e) {
        report.errors.push(`${item.id}: ${errText(e)}`);
      }
    }
    const finished = all.filter((x) => x.done);
    for (let i = 0; i < finished.length && now() < stop; i += 100) {
      const batch = finished.slice(i, i + 100);
      try {
        const infos = await d.rpc.getMultipleAccountsInfo(batch.map((x) => new PublicKey(x.address)), 'confirmed');
        for (let j = 0; j < batch.length && now() < stop; j++) {
          if ((infos[j]?.lamports ?? 0) <= LATE_MIN_LAMPORTS) continue;
          report.late++;
          const r = await run(batch[j].id, { deadline });
          if (r.ran) report.ran++;
        }
      } catch (e) {
        report.errors.push(`late check: ${errText(e)}`);
      }
    }
    log({ evt: 'launch.cron', ...report, errors: report.errors.length });
    return report;
  }

  // ── a launched coin, public ─────────────────────────────────────────
  async function coin(kitId) {
    if (!KIT_ID_RE.test(kitId)) return null;
    const c = await d.readCoin(kitId);
    if (!c) return null;
    const pad = adOf(c).links(c.mint, c.cluster);
    return {
      ...c, feeModel: c.feeModel ?? 'split', launchpadName: padOf(c.launchpad ?? 'pumpfun')?.name ?? 'pump.fun',
      links: { pump: (c.launchpad ?? 'pumpfun') === 'pumpfun' ? pad?.url ?? null : null, pad, mint: `https://solscan.io/token/${c.mint}${c.cluster === 'devnet' ? '?cluster=devnet' : ''}`, coin: links.coin(kitId) },
    };
  }

  return { config, quote, create, status, askRefund, run, cron, coin, gate, missing, params: P, settings: s };
}
