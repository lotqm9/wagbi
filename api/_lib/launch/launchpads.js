// The launch picker: chain -> launchpad -> currency -> the launchpad's own options -> fees. One adapter per
// launchpad and currency (adapters/*.js); what has no adapter, or is switched off here, shows as "soon" with why.
// Everything below was read from live docs, SDKs and the chain on 2026-11-01/02 (LAUNCH-SPEC.md, "Launchpads").
//
// Fees (Laith, 2026-11-02): on pump.fun the split stays as built, wagbi's 15% locked on chain and the rest the
// creator's to share. On EVERY other launchpad the creator keeps all the creator fees and wagbi takes nothing.
//
// Switches (env, per deployment): WAGBI_LAUNCH_<ID>=on|off, e.g. WAGBI_LAUNCH_METEORA_DBC=on. A launchpad proven on
// devnet is on by default on a DEVNET deployment and off on mainnet until Laith switches it on; one with no devnet
// (LetsBonk, Bags) is off everywhere until he does. pump.fun on SOL has no switch (it is the original).
import { pumpfun } from './adapters/pumpfun.js';
import { pumpfunUsdc } from './adapters/pumpfunUsdc.js';
import { letsbonk, raydiumLaunchlab } from './adapters/launchlab.js';
import { meteoraDbc } from './adapters/meteoraDbc.js';
import { bags } from './adapters/bags.js';
import { BRAND } from '../brand.js';
import { BAGS_FEE_NOTE, chartOf, factsOf } from './facts.js';

export { chartOf, factsOf };

export const CHAINS = [
  { id: 'solana', name: 'Solana', status: 'live' },
  { id: 'base', name: 'Base', status: 'soon' },
  { id: 'bnb', name: 'BNB Chain', status: 'soon' },
];

// Fee facts per launchpad (facts.js) ride along in the view: the picker's cards and the fees step show them.
export const LAUNCHPADS = [
  {
    id: 'pumpfun', chain: 'solana', name: 'pump.fun', feeModel: 'split',
    blurb: 'the bonding curve everyone watches. creator fees split across your wallets, locked on chain.',
    feeDetail: null,
    currencies: [
      { id: 'SOL', adapter: pumpfun },
      {
        id: 'USDC', adapter: pumpfunUsdc, flag: 'WAGBI_LAUNCH_PUMPFUN_USDC', proven: true,
        note: "no first buy on a USDC pair: pump.fun's USDC pairs are bought with USDC, and your deposit is SOL. creator fees come in USDC.",
      },
    ],
  },
  {
    id: 'raydium-launchlab', chain: 'solana', name: 'Raydium LaunchLab', feeModel: 'creator',
    blurb: "raydium's launchpad. graduates to a raydium CPMM pool.",
    feeDetail: "your wallet is the coin's creator from the first trade, and you claim the fees on raydium.io. the rate is raydium's platform rate: 0.05% of every trade on mainnet (read 2026-11-02).",
    currencies: [{ id: 'SOL', adapter: raydiumLaunchlab, flag: 'WAGBI_LAUNCH_RAYDIUM_LAUNCHLAB', proven: true }],
  },
  {
    id: 'letsbonk', chain: 'solana', name: 'LetsBonk', feeModel: 'creator',
    blurb: "bonk.fun's standard coin, on raydium launchlab.",
    feeDetail: "but bonk.fun pays creators none: 0% on the curve, and after graduation the pool's creator fee goes to bonk.fun's own wallet (its platform config, read 2026-11-02).",
    currencies: [{ id: 'SOL', adapter: letsbonk, flag: 'WAGBI_LAUNCH_LETSBONK', proven: false, why: 'mainnet only (bonk.fun has no devnet), so it stays off until it is switched on.' }],
  },
  {
    id: 'meteora-dbc', chain: 'solana', name: 'Meteora DBC', feeModel: 'creator',
    blurb: 'a dynamic bonding curve with your own market caps and fees. graduates to a locked Meteora pool.',
    feeDetail: "that's 80% of every trading fee (Meteora keeps 20%), and the locked liquidity's fees after graduation. you claim them on meteora.ag.",
    currencies: [{ id: 'SOL', adapter: meteoraDbc, flag: 'WAGBI_LAUNCH_METEORA_DBC', proven: true }],
  },
  {
    id: 'bags', chain: 'solana', name: 'Bags', feeModel: 'creator',
    blurb: 'fee sharing built in, launched through the Bags API.',
    // LAUNCH-SPEC.md "Bags", open problem: the fee-share config's payer (the deposit) automatically gets 25% of the
    // claimers' pool (Deployer Fees, since September 2026), so "all yours" isn't true on Bags until that is solved.
    feeDetail: "the claimers' pool goes to your wallet, except the 25% Bags gives the fee setup's payer (here, the deposit). Bags keeps its own 1% of every trade.",
    feeNote: BAGS_FEE_NOTE,
    currencies: [{ id: 'SOL', adapter: bags, flag: 'WAGBI_LAUNCH_BAGS', proven: false, why: 'needs a Bags API key and has no devnet, so it stays off until it is switched on.' }],
  },
  {
    id: 'moonit', chain: 'solana', name: 'Moonit', feeModel: 'creator',
    blurb: 'formerly moonshot.',
    feeDetail: null,
    currencies: [{ id: 'SOL', adapter: null, why: "its own server co-signs every launch, the first-buy coins can't go to your wallet, and creators earn nothing on the curve (checked 2026-11-02)." }],
  },
];

const envName = (flag) => flag;
/** on / off for a currency's switch on this deployment. */
function switchedOn(cur, s) {
  if (!cur.flag) return true;
  const v = s.switches?.[envName(cur.flag)];
  if (v === 'on') return true;
  if (v === 'off') return false;
  return !!cur.proven && s.cluster === 'devnet';
}

/** Whether a launchpad's currency can launch on this deployment, and if not, why (plain words). */
export function statusOf(pad, cur, s) {
  const ad = cur.adapter;
  if (!ad) return { status: 'soon', why: cur.why ?? `${pad.name} isn't wired yet.` };
  if (!ad.clusters.includes(s.cluster)) return { status: 'soon', why: `${pad.name} has no ${s.cluster} deployment.` };
  if (!switchedOn(cur, s)) return { status: 'soon', why: cur.why ?? `${pad.name} isn't switched on here yet.` };
  if (ad.needsKey && !s.bagsKeySet) return { status: 'soon', why: `${pad.name} needs its API key on this site.` };
  if (ad.feeModel === 'split' && !s.feeWallet) return { status: 'soon', why: 'launches open soon.' };
  return { status: 'live', why: null };
}

/** What the page shows (no adapters, nothing secret). */
export function pickerView(s) {
  return {
    chains: CHAINS,
    launchpads: LAUNCHPADS.map((pad) => {
      const currencies = pad.currencies.map((cur) => {
        const st = statusOf(pad, cur, s);
        const ad = cur.adapter;
        return {
          id: cur.id, status: st.status, why: st.why, note: cur.note ?? null,
          firstBuy: !!ad?.firstBuy, maxWallets: ad?.feeModel === 'split' ? ad.maxWallets : null, options: ad?.options ?? [],
          facts: factsOf(pad.id, cur.id),
        };
      });
      const live = currencies.some((c) => c.status === 'live');
      return {
        id: pad.id, chain: pad.chain, name: pad.name, blurb: pad.blurb, feeModel: pad.feeModel,
        // the plain words the launch screen shows (Laith, 2026-11-02): "you keep all the creator fees on <platform>"
        feeNote: pad.feeNote ?? (pad.feeModel === 'creator' && pad.currencies.some((c) => c.adapter) ? `you keep all the creator fees on ${pad.name}. ${BRAND.name} takes nothing.` : null),
        feeDetail: pad.feeDetail ?? null,
        facts: factsOf(pad.id, null),
        status: live ? 'live' : 'soon', why: live ? null : currencies[0]?.why ?? null,
        maxWallets: currencies.find((c) => c.maxWallets)?.maxWallets ?? null,
        currencies,
      };
    }),
  };
}

/** The adapter for a launch this deployment can make now, or null (with why, in plain words). */
export function adapterFor(chain, launchpad, currency, s) {
  const c = CHAINS.find((x) => x.id === chain);
  if (!c) return { adapter: null, why: 'pick a chain.' };
  if (c.status !== 'live') return { adapter: null, why: `${c.name} isn't open yet. launch on solana for now.` };
  const pad = LAUNCHPADS.find((x) => x.id === launchpad && x.chain === chain);
  if (!pad) return { adapter: null, why: 'pick a launchpad.' };
  const cur = pad.currencies.find((x) => x.id === currency);
  if (!cur) return { adapter: null, why: `${pad.name} doesn't launch ${String(currency).slice(0, 10)} pairs.` };
  const st = statusOf(pad, cur, s);
  if (st.status !== 'live') {
    const others = pad.currencies.filter((x) => x !== cur && statusOf(pad, x, s).status === 'live');
    const why = pad.currencies.length > 1 && others.length ? `${currency} pairs aren't open yet on ${pad.name}. use ${others[0].id} for now.` : `${pad.name} isn't open yet: ${st.why}`;
    return { adapter: null, why };
  }
  return { adapter: cur.adapter, launchpad: pad, why: null };
}

/** The adapter a deposit was made for, switched on or not (a deposit made while it was on always finishes). */
export function adapterOf(rec) {
  const pad = LAUNCHPADS.find((x) => x.id === (rec?.launchpad ?? 'pumpfun'));
  return pad?.currencies.find((x) => x.id === (rec?.currency ?? 'SOL'))?.adapter ?? null;
}
export const padOf = (id) => LAUNCHPADS.find((x) => x.id === id) ?? null;

/** Every adapter's guard, by the name its policies carry. */
export const GUARDS = Object.fromEntries(
  [pumpfunUsdc, raydiumLaunchlab, letsbonk, meteoraDbc, bags].map((a) => [a.guard, (tx, p) => a.checkTx(tx, p)]),
);
