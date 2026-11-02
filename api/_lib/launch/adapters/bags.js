// Bags (bags.fm). BUILT, NOT SWITCHED ON: it needs BAGS_API_KEY (every launch call does) and WAGBI_LAUNCH_BAGS=on,
// and Bags has no devnet, so this is tested with mocks only (test/launch-pads.test.mjs). Read live 2026-11-02
// (LAUNCH-SPEC.md, "Bags"): @bagsfm/bags-sdk 1.4.4 (2026-08-23) src/services/{token-launch,config}.ts, docs.bags.fm
// (launch-token, create-fee-share-configuration, create-token-launch-transaction, deployer-fees, program-ids).
//
// Bags builds the transactions on its own servers; the deposit key only signs what this file's guard allows:
//   prep    POST /token-launch/create-token-info (Bags hosts the metadata and picks the mint, whose key Bags holds),
//           then POST /fee-share/config: ONE claimer, the payout wallet at 100%, its admin the payout wallet too.
//           Bags answers with the config transaction for the deposit to sign (a Jito bundle answer is refused).
//   create  POST /token-launch/create-launch-transaction: Bags' Meteora DBC create, already signed by the mint.
// No first buy: Bags sends first-buy coins to the launching wallet (here the one-time deposit) and has no
// receiver field, and moving them on is not built.
// KNOWN GAP (docs, Deployer Fees, 2026-09): the config's payer gets a separate 25% of the claimer pool, and the
// payer has to sign, so it is the deposit: that share would sit in the deposit key. Laith decides before this is on.
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { LaunchError, base58 } from 'printer-engine/launch';
import { P, checkBase, keyAt, progOf } from '../chain.js';

export const BAGS_API = 'https://public-api-v2.bags.fm/api/v1';
export const BAGS_FEE_SHARE_V2 = 'FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK';
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const LAUNCH_PROGRAMS = [DBC, BAGS_FEE_SHARE_V2, P.ata, P.token, P.token2022, P.metaplex];
/** config + create + fees, with room (Bags' own numbers aren't published; the spend cap below holds whatever). */
const NETWORK_LAMPORTS = 40_000_000;

const fromB58 = (s) => {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
};

async function call(ctx, path, body, form) {
  if (!ctx.bagsKey) throw new LaunchError('config', 'BAGS_API_KEY missing', "Bags isn't set up on this site.");
  const f = ctx.fetch ?? fetch;
  let r;
  try {
    r = await f(`${BAGS_API}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': ctx.bagsKey, ...(form ? {} : { 'Content-Type': 'application/json' }) },
      body: form ?? JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new LaunchError('chain', `bags ${path}: ${String(e?.message ?? e).slice(0, 120)}`, "Bags couldn't be reached. try again in a minute.");
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    /* not json */
  }
  if (!r.ok || !j?.success) throw new LaunchError('chain', `bags ${path} ${r.status}: ${String(j?.error ?? '').slice(0, 160)}`, "Bags didn't accept the coin. nothing was sent.");
  return j.response;
}

export const bags = {
  id: 'bags', chain: 'solana', name: 'Bags', feeModel: 'creator', firstBuy: false, clusters: ['mainnet'], guard: 'bags', needsKey: true, fixedTx: true,
  options: [],
  cleanOptions(raw) {
    if (raw && typeof raw === 'object' && Object.keys(raw).length) throw new LaunchError('bad_input', 'bags options', 'Bags has no options to set.');
    return {};
  },
  networkLamports: () => NETWORK_LAMPORTS,
  async estimateFirstBuy() {
    return null;
  },

  /** The token info (Bags' metadata and mint) and the fee-share config transaction. Not signed. */
  async buildPrep({ deposit, payout, coin, ctx, blockhash }) {
    void blockhash;
    const form = new FormData();
    form.append('imageUrl', coin.imageUrl);
    form.append('name', coin.name);
    form.append('symbol', coin.ticker);
    form.append('description', coin.lore || coin.name);
    if (coin.links?.x) form.append('twitter', coin.links.x);
    if (coin.links?.website) form.append('website', coin.links.website);
    const info = await call(ctx, '/token-launch/create-token-info', null, form);
    const tokenMint = new PublicKey(info.tokenMint).toBase58();
    const metadataUrl = String(info.tokenMetadata ?? info.tokenLaunch?.uri ?? '');
    if (!/^https:\/\//.test(metadataUrl)) throw new LaunchError('chain', 'bags returned no metadata url', "Bags didn't accept the coin. nothing was sent.");
    const cfg = await call(ctx, '/fee-share/config', { payer: deposit, baseMint: tokenMint, claimersArray: [payout], basisPointsArray: [10_000], admin: payout, bagsConfigType: undefined });
    if (cfg.bundles?.length || (cfg.transactions ?? []).length !== 1) throw new LaunchError('chain', `bags config: ${cfg.transactions?.length ?? 0} txs, ${cfg.bundles?.length ?? 0} bundles`, "Bags asked for a kind of launch wagbi doesn't do. nothing was sent.");
    const tx = VersionedTransaction.deserialize(fromB58(cfg.transactions[0].transaction));
    const configKey = new PublicKey(cfg.meteoraConfigKey).toBase58();
    return { tx, size: tx.serialize().length, extraSigners: [], data: { tokenMint, metadataUrl, configKey }, policy: { guard: 'bags', kind: 'prep', payout, signers: [] } };
  },
  async prepExists(rpc, { configKey }) {
    return !!(await rpc.getAccountInfo(new PublicKey(configKey), 'confirmed'));
  },

  /** Bags' launch transaction (already signed by the mint Bags holds). Not signed by the deposit yet. */
  async buildCreate({ deposit, payout, name, symbol, prep, ctx }) {
    const b58 = await call(ctx, '/token-launch/create-launch-transaction', { ipfs: prep.metadataUrl, tokenMint: prep.tokenMint, wallet: deposit, initialBuyLamports: 0, configKey: prep.configKey });
    const tx = VersionedTransaction.deserialize(fromB58(String(b58)));
    return { tx, size: tx.serialize().length, mint: prep.tokenMint, extraSigners: [], policy: { guard: 'bags', kind: 'create', payout, mint: prep.tokenMint, config: prep.configKey, signers: [prep.tokenMint], presigned: [prep.tokenMint], coin: { name, symbol } } };
  },
  async coinExists(rpc, mint) {
    return !!(await rpc.getAccountInfo(new PublicKey(mint), 'confirmed'));
  },
  async readLaunch(rpc, { mint }) {
    const info = await rpc.getAccountInfo(new PublicKey(mint), 'confirmed');
    return info ? { state: 'live', problem: null } : { state: 'waiting', problem: null };
  },
  links(mint, cluster) {
    return cluster === 'mainnet' ? { url: `https://bags.fm/${mint}`, label: 'open on Bags' } : null;
  },

  /**
   * Bags' transactions come from Bags' servers, so the guard holds the line without trusting them: the deposit pays
   * and is the only signer we add (the create's mint signature must already be there), only Bags' fee-share
   * program and Meteora's DBC (plus token-account programs) are called, and the deposit never sends SOL by a
   * top-level transfer. The service also simulates every transaction and refuses one that would take more from the
   * deposit than the launch's network costs (the spend cap), whatever its instructions say.
   */
  checkTx(tx, p) {
    const programs = p.kind === 'prep' ? [BAGS_FEE_SHARE_V2, P.system] : [...LAUNCH_PROGRAMS, P.system];
    const { problems, body } = checkBase(tx, { ...p, programs, tables: p.tables ?? [] });
    for (const ix of body) {
      if (progOf(ix) === P.system) {
        const d = Uint8Array.from(ix.data);
        const kind = d.length >= 4 ? d[0] | (d[1] << 8) : -1;
        if (kind === 2) problems.push('a Bags transaction sends SOL straight out of the deposit.');
        else if (kind !== 0 && kind !== 8) problems.push('a Bags transaction asks the System program for something other than a new account.');
        if (kind === 0 && keyAt(ix, 0) !== p.deposit) problems.push('a new account is paid by someone else.');
      }
    }
    if (p.kind === 'create') {
      const sigs = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
      const at = sigs.indexOf(p.mint);
      if (at < 0 || tx.signatures[at].every((x) => x === 0)) problems.push("Bags' create isn't signed by the coin's mint.");
      if (!body.some((ix) => progOf(ix) === DBC && keyAt(ix, 3) === p.mint && keyAt(ix, 0) === p.config)) problems.push("Bags' create isn't this coin's pool on its fee-share config.");
    }
    void base58;
    return problems;
  },
};
