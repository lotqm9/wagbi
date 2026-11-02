// The coins tab's data: live market numbers (launch/market.js), the fee facts and links (launch/facts.js), and the
// coins API's view of a launch record. No network: DexScreener and the RPC are fakes fed recorded shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodeCurve as engineDecodeCurve, bondingCurveOf as engineCurveOf } from 'printer-engine/launch';
import { bondingCurveOf, createMarket, curveNumbers, decodeCurve, fromPair, pickPair } from '../api/_lib/launch/market.js';
import { PAD_INFO, chartOf, explorerOf, factsOf, padLinkOf } from '../api/_lib/launch/facts.js';
import { LAUNCHPADS, pickerView } from '../api/_lib/launch/launchpads.js';
import { launchView } from '../api/coins.js';

const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** A pump.fun bonding curve account as the program writes it (printer-engine's layout). */
function curveBytes({ vt, vq, rt, rq, supply = 1_000_000_000_000_000n, complete = false, quoteMint = null }) {
  const b = Buffer.alloc(8 + 8 * 5 + 1 + 32 + 2 + 32 + 8 + 1 + 1 + 8);
  Buffer.from('17b7f83760d8ac60', 'hex').copy(b, 0);
  [vt, vq, rt, rq, supply].forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 8 + i * 8));
  b[48] = complete ? 1 : 0;
  Keypair.generate().publicKey.toBuffer().copy(b, 49);
  if (quoteMint) new PublicKey(quoteMint).toBuffer().copy(b, 83);
  return b;
}
function globalBytes(initialRealTokenReserves = 793_100_000_000_000n) {
  const b = Buffer.alloc(200);
  b.writeBigUInt64LE(initialRealTokenReserves, 89);
  return b;
}

test('the curve decoder reads what printer-engine reads, and the curve PDA is the same', () => {
  const mint = Keypair.generate().publicKey.toBase58();
  assert.equal(bondingCurveOf(mint), engineCurveOf(mint));
  for (const quoteMint of [null, USDC_MAINNET]) {
    const raw = curveBytes({ vt: 1_000_000_000_000_000n, vq: 32_000_000_000n, rt: 700_000_000_000_000n, rq: 2_000_000_000n, quoteMint });
    const mine = decodeCurve(raw);
    const theirs = engineDecodeCurve(Uint8Array.from(raw));
    for (const k of ['virtualTokenReserves', 'virtualQuoteReserves', 'realTokenReserves', 'realQuoteReserves', 'tokenTotalSupply', 'complete', 'quoteMint']) assert.equal(String(mine[k]), String(theirs[k]), k);
  }
  assert.equal(decodeCurve(Buffer.alloc(120)), null, 'not a curve');
});

test('curve numbers: price, market cap in the quote, and how far to graduating', () => {
  // pump.fun's fresh SOL curve on mainnet: 30 SOL against 1,073,000,000 coins virtual, 793.1M real to sell
  const fresh = decodeCurve(curveBytes({ vt: 1_073_000_000_000_000n, vq: 30_000_000_000n, rt: 793_100_000_000_000n, rq: 0n }));
  const n = curveNumbers(fresh, 793_100_000_000_000n, 'mainnet');
  assert.equal(n.quote, 'SOL');
  assert.ok(Math.abs(n.mcap - 27.958993) < 1e-4, `fresh mcap ${n.mcap}`);
  assert.equal(n.progressPct, 0);
  const half = decodeCurve(curveBytes({ vt: 676_450_000_000_000n, vq: 47_600_000_000n, rt: 396_550_000_000_000n, rq: 17_600_000_000n }));
  assert.equal(curveNumbers(half, 793_100_000_000_000n, 'mainnet').progressPct, 50);
  const done = decodeCurve(curveBytes({ vt: 0n, vq: 0n, rt: 0n, rq: 0n, complete: true }));
  assert.deepEqual([curveNumbers(done, 793_100_000_000_000n, 'mainnet').progressPct, curveNumbers(done, null, 'mainnet').price], [100, null]);
  const usdc = decodeCurve(curveBytes({ vt: 1_073_000_000_000_000n, vq: 4_000_000_000n, rt: 793_100_000_000_000n, rq: 0n, quoteMint: USDC_MAINNET }));
  const u = curveNumbers(usdc, 793_100_000_000_000n, 'mainnet');
  assert.equal(u.quote, 'USDC');
  assert.ok(Math.abs(u.mcap - 3727.865) < 0.01, `usdc mcap ${u.mcap}`);
});

test('the DexScreener pair: the deepest one the coin is the base of; a curve (no liquidity) by volume', () => {
  const mint = 'HckPgvvNVNnFRZsYRNGMbeSs362dLLhZGjzNmqpgf9gk';
  const pair = (o) => ({ chainId: 'solana', dexId: 'pumpswap', url: 'https://dexscreener.com/solana/p', baseToken: { address: mint }, priceUsd: '0.00001838', marketCap: 17806, fdv: 17806, volume: { h24: 288182.23 }, priceChange: { h24: -53.08 }, liquidity: { usd: 9794.85 }, ...o });
  const best = pickPair([pair({ liquidity: { usd: 10 } }), pair({ url: 'https://dexscreener.com/solana/deep' }), pair({ chainId: 'base', liquidity: { usd: 1e9 } }), pair({ baseToken: { address: 'other' }, liquidity: { usd: 1e9 } })], mint);
  assert.equal(best.url, 'https://dexscreener.com/solana/deep');
  assert.deepEqual(fromPair(best), { priceUsd: 0.00001838, mcapUsd: 17806, volume24hUsd: 288182.23, change24hPct: -53.08, liquidityUsd: 9794.85, dex: 'pumpswap', pairUrl: 'https://dexscreener.com/solana/deep' });
  const curves = [pair({ dexId: 'pumpfun', liquidity: undefined, volume: { h24: 5 }, url: 'https://dexscreener.com/solana/a' }), pair({ dexId: 'pumpfun', liquidity: undefined, volume: { h24: 50 }, url: 'https://dexscreener.com/solana/b' })];
  assert.equal(pickPair(curves, mint).url, 'https://dexscreener.com/solana/b');
  assert.equal(pickPair([], mint), null);
  assert.equal(fromPair(pair({ url: 'https://evil.example/x', marketCap: null })).pairUrl, null);
  assert.equal(fromPair(pair({ marketCap: null })).mcapUsd, 17806, 'fdv stands in for a missing market cap');
});

function fakeRpc(accounts) {
  return {
    calls: 0,
    async getMultipleAccountsInfo(keys) {
      this.calls++;
      return keys.map((k) => (accounts[k.toBase58()] ? { data: accounts[k.toBase58()] } : null));
    },
  };
}
const GLOBAL = PublicKey.findProgramAddressSync([Buffer.from('global')], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58();

test('the market reader: DexScreener on mainnet plus the pump.fun curve; the chain alone on devnet; failures leave nulls', async () => {
  const pumpMint = Keypair.generate().publicKey.toBase58();
  const labMint = Keypair.generate().publicKey.toBase58();
  const rpc = fakeRpc({
    [GLOBAL]: globalBytes(),
    [bondingCurveOf(pumpMint)]: curveBytes({ vt: 676_450_000_000_000n, vq: 47_600_000_000n, rt: 396_550_000_000_000n, rq: 17_600_000_000n }),
  });
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => [{ chainId: 'solana', dexId: 'pumpfun', url: 'https://dexscreener.com/solana/pp', baseToken: { address: pumpMint }, priceUsd: '0.0000071', marketCap: 7100, volume: { h24: 1200 }, priceChange: { h24: 12.5 } }] };
  };
  const m = createMarket({ rpc, cluster: 'mainnet', fetch });
  const r = await m.read([{ id: 'p', mint: pumpMint, launchpad: 'pumpfun' }, { id: 'l', mint: labMint, launchpad: 'raydium-launchlab' }, { id: 'bad', mint: 'not a mint' }]);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith('https://api.dexscreener.com/tokens/v1/solana/') && asked[0].includes(pumpMint) && asked[0].includes(labMint));
  assert.deepEqual([r.p.source, r.p.mcapUsd, r.p.volume24hUsd, r.p.change24hPct, r.p.curve.progressPct, r.p.pairUrl], ['dexscreener', 7100, 1200, 12.5, 50, 'https://dexscreener.com/solana/pp']);
  assert.deepEqual([r.l.source, r.l.mcapUsd, r.l.curve], [null, null, null], 'no pair yet and no curve: nothing invented');
  assert.equal(r.bad, undefined);
  // cached: a second read within the window asks nobody
  await m.read([{ id: 'p', mint: pumpMint, launchpad: 'pumpfun' }]);
  assert.equal(asked.length, 1);

  const devRpc = fakeRpc({ [GLOBAL]: globalBytes(), [bondingCurveOf(pumpMint)]: curveBytes({ vt: 1_073_000_000_000_000n, vq: 300_000_000n, rt: 793_100_000_000_000n, rq: 0n }) });
  const devFetch = async () => { throw new Error('devnet must not ask DexScreener'); };
  const d = await createMarket({ rpc: devRpc, cluster: 'devnet', fetch: devFetch }).read([{ id: 'p', mint: pumpMint, launchpad: 'pumpfun' }]);
  assert.deepEqual([d.p.source, d.p.mcapUsd, Math.round(d.p.curve.mcap * 1000) / 1000, d.p.curve.progressPct], ['chain', null, 0.28, 0]);

  const logged = [];
  const down = createMarket({ rpc: { getMultipleAccountsInfo: async () => { throw new Error('failed to reach https://rpc.example/?api-key=SECRET123'); } }, cluster: 'mainnet', fetch: async () => ({ ok: false, status: 429 }), log: (e) => logged.push(e) });
  const z = await down.read([{ id: 'p', mint: pumpMint, launchpad: 'pumpfun' }]);
  assert.deepEqual([z.p.source, z.p.mcapUsd, z.p.curve], [null, null, null]);
  assert.ok(logged.length >= 2 && !JSON.stringify(logged).includes('SECRET123') && JSON.stringify(logged).includes('<url>'), 'a paid RPC URL never reaches the logs');
});

test("the facts and links: every launchpad's coin link is its adapter's own, and devnet has no market links", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  for (const pad of LAUNCHPADS) {
    assert.ok(PAD_INFO[pad.id], `${pad.id} has facts`);
    assert.equal(PAD_INFO[pad.id].name, pad.name);
    for (const cur of pad.currencies) {
      if (!cur.adapter) continue;
      const theirs = cur.adapter.links(mint, 'mainnet');
      assert.deepEqual(padLinkOf(pad.id, mint, 'mainnet'), theirs, `${pad.id} link`);
      assert.equal(padLinkOf(pad.id, mint, 'devnet'), null);
    }
  }
  assert.match(factsOf('pumpfun', 'USDC').rate, /0\.30% of every trade/);
  assert.equal(factsOf('pumpfun', 'USDC').paidIn, 'USDC');
  assert.equal(factsOf('pumpfun', 'SOL').rate, null, 'no SOL rate in the spec: none shown');
  assert.match(factsOf('raydium-launchlab', 'SOL').rate, /0\.05%/);
  assert.match(factsOf('meteora-dbc', 'SOL').rate, /80%/);
  assert.match(factsOf('bags', 'SOL').caveat, /25%/);
  assert.equal(chartOf(mint, 'devnet'), null);
  assert.equal(chartOf(mint, 'mainnet'), `https://dexscreener.com/solana/${mint}`);
  assert.equal(chartOf(mint, 'mainnet', 'https://dexscreener.com/solana/pair'), 'https://dexscreener.com/solana/pair');
  assert.equal(explorerOf(mint, 'devnet'), `https://solscan.io/token/${mint}?cluster=devnet`);
  const v = pickerView({ cluster: 'devnet', feeWallet: mint, switches: {} });
  assert.match(v.launchpads.find((l) => l.id === 'bags').feeNote, /25%/, "Bags never says 'all of it'");
  assert.equal(v.launchpads.find((l) => l.id === 'pumpfun').currencies.find((c) => c.id === 'USDC').facts.paidIn, 'USDC');
});

test('the coins API shows a launch record with its launchpad, its links and its split (bps only)', () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const rec = { kitId: 'abcdefghijklmnop', mint, launchpad: 'pumpfun', currency: 'SOL', feeModel: 'split', launchedAt: '2026-11-02T09:01:11.860Z', split: [{ role: 'creator', address: 'A', bps: 8500 }, { role: 'wagbi', address: 'B', bps: 1500 }] };
  const main = launchView(rec, 'mainnet');
  assert.deepEqual([main.launchpadName, main.links.pad.url, main.links.chart, main.split], ['pump.fun', `https://pump.fun/coin/${mint}`, `https://dexscreener.com/solana/${mint}`, [{ role: 'creator', bps: 8500 }, { role: 'wagbi', bps: 1500 }]]);
  const dev = launchView({ ...rec, launchpad: 'meteora-dbc', feeModel: 'creator' }, 'devnet');
  assert.deepEqual([dev.launchpadName, dev.links.pad, dev.links.chart], ['Meteora DBC', null, null]);
  assert.match(dev.links.explorer, /cluster=devnet$/);
  const old = launchView({ kitId: rec.kitId, mint, launchedAt: rec.launchedAt }, 'mainnet');
  assert.deepEqual([old.launchpad, old.currency, old.feeModel], ['pumpfun', 'SOL', 'split'], 'records from before the picker are pump.fun on SOL');
});
