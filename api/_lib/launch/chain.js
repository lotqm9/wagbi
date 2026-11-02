// The Solana pieces every launchpad adapter shares: well-known program ids, coin accounts, wrapping SOL for a
// first buy, compiling a transaction (with its size checked), and the base of every adapter's guard. Server only.
//
// The guard base (checkBase) holds what is true of EVERY transaction a deposit key signs, whatever the launchpad:
//   - the deposit pays, and the only other signers are the fresh keys the policy names (the coin's mint, a
//     per-launch config account): never someone else's key;
//   - it reads only the lookup tables the policy names, with their real contents;
//   - it calls only the programs the policy allows;
//   - its priority fee stays under the engine's cap.
// Each adapter's own guard then reads every remaining instruction, in order, against the launch it was made for.
import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PRIORITY_MAX_SOL, TX_MAX_BYTES, decodeComputeBudget, decodeSystemTransfer, txSize } from 'printer-engine/launch';

export const P = Object.freeze({
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  metaplex: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  rent: 'SysvarRent111111111111111111111111111111111',
  instructions: 'Sysvar1nstructions1111111111111111111111111',
});
export const WSOL = 'So11111111111111111111111111111111111111112';
/** USDC per cluster (pump.fun's whitelisted quote mint on each, read from Global 2026-11-02). */
export const USDC = Object.freeze({ mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' });
/** The most compute units one transaction may ask for. */
export const MAX_CU = 1_400_000;
/** Rent for a 165-byte token account (lamports): what a coin account or a wrapped-SOL account costs to open. */
export const TOKEN_ACCOUNT_RENT = 2_039_280;

const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
export const b58 = (k) => (k instanceof PublicKey ? k.toBase58() : String(k));

/** A coin account address (ATA). */
export const ataOf = (mint, owner, tokenProgram = P.token) => getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(tokenProgram)).toBase58();

/** CreateIdempotent: opens owner's coin account for mint, paid by payer (does nothing when it exists). */
export function ataIx(payer, owner, mint, tokenProgram = P.token) {
  const ata = ataOf(mint, owner, tokenProgram);
  return new TransactionInstruction({
    programId: pk(P.ata),
    keys: [
      { pubkey: pk(payer), isSigner: true, isWritable: true },
      { pubkey: pk(ata), isSigner: false, isWritable: true },
      { pubkey: pk(owner), isSigner: false, isWritable: false },
      { pubkey: pk(mint), isSigner: false, isWritable: false },
      { pubkey: pk(P.system), isSigner: false, isWritable: false },
      { pubkey: pk(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
const syncNativeIx = (account) => new TransactionInstruction({ programId: pk(P.token), keys: [{ pubkey: pk(account), isSigner: false, isWritable: true }], data: Buffer.from([17]) });
const closeIx = (account, dest, owner) =>
  new TransactionInstruction({
    programId: pk(P.token),
    keys: [{ pubkey: pk(account), isSigner: false, isWritable: true }, { pubkey: pk(dest), isSigner: false, isWritable: true }, { pubkey: pk(owner), isSigner: true, isWritable: false }],
    data: Buffer.from([9]),
  });

/** The deposit's own wrapped-SOL account: opened, filled with `lamports` and synced (before a buy that spends SOL as a token). */
export function wrapIxs(deposit, lamports) {
  const w = ataOf(WSOL, deposit);
  return [ataIx(deposit, deposit, WSOL), SystemProgram.transfer({ fromPubkey: pk(deposit), toPubkey: pk(w), lamports: BigInt(lamports) }), syncNativeIx(w)];
}
/** Closes the deposit's wrapped-SOL account back into the deposit (what the buy didn't spend, and the account's rent). */
export const unwrapIx = (deposit) => closeIx(ataOf(WSOL, deposit), deposit, deposit);

export class TooBig extends Error {
  constructor(label, size) {
    super(`the ${label} transaction is ${size} bytes, over the ${TX_MAX_BYTES}-byte limit`);
    this.name = 'TooBig';
    this.size = size;
  }
}

/** A v0 transaction: its compute limit and price first, then the body. Throws TooBig past Solana's limit. Not signed. */
export function compileTx({ label, payer, blockhash, cu, cuPrice, body, tables = [] }) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }), ...body];
  const msg = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables);
  const size = txSize(msg);
  if (size > TX_MAX_BYTES) throw new TooBig(label, size);
  return { tx: new VersionedTransaction(msg), size };
}

/** The micro-lamport price that spends about `lamports` of priority fee over `units` of compute (0 is 0). */
export const cuPriceFor = (lamports, units) => (lamports > 0 && units > 0 ? Math.max(1, Math.floor((lamports * 1_000_000) / units)) : 0);

// ── reading a transaction back, for the guards ─────────────────────────────

export const hex8 = (ix) => Buffer.from(Uint8Array.from(ix.data).subarray(0, 8)).toString('hex');
export const keyAt = (ix, i) => ix.keys[i]?.pubkey.toBase58() ?? '';
export const progOf = (ix) => ix.programId.toBase58();

/**
 * The checks every deposit transaction gets (see the top of this file). Returns the problems and the instructions
 * after the compute budget, decompiled with the policy's tables. policy: { deposit, signers: [extra signer keys],
 * tables: [AddressLookupTableAccount], programs: [program ids the body may call] }.
 */
export function checkBase(tx, p) {
  const problems = [];
  const msg = tx.message;
  const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
  if (signers[0] !== p.deposit) problems.push("the deposit isn't the fee payer.");
  const allowed = [p.deposit, ...(p.signers ?? [])];
  if ([...signers].sort().join() !== [...allowed].sort().join()) problems.push('the transaction asks for a signer the launch did not make.');
  let ixs;
  try {
    const used = msg.addressTableLookups.map((l) => l.accountKey.toBase58());
    const have = (p.tables ?? []).filter((t) => used.includes(t.key.toBase58()));
    if (have.length !== used.length) return { problems: [...problems, "the transaction reads a lookup table the guard doesn't have."], body: [] };
    ixs = TransactionMessage.decompile(msg, { addressLookupTableAccounts: have }).instructions;
  } catch (e) {
    return { problems: [...problems, `the transaction couldn't be read (${e.message}).`], body: [] };
  }
  let limit = null;
  let price = 0n;
  let budgets = 0;
  for (const ix of ixs) {
    if (progOf(ix) !== P.computeBudget) continue;
    budgets++;
    const d = decodeComputeBudget(Uint8Array.from(ix.data));
    if (!d) problems.push('an unknown compute budget instruction.');
    else if (d.kind === 'limit') limit = d.units;
    else price = d.microLamports;
  }
  if (budgets > 2) problems.push('more than one compute limit and one price.');
  const priority = limit ? (price * BigInt(limit) + 999_999n) / 1_000_000n : 0n;
  if (priority > BigInt(Math.round(PRIORITY_MAX_SOL * 1e9))) problems.push('the priority fee is over the cap.');
  const body = ixs.filter((ix) => progOf(ix) !== P.computeBudget);
  for (const ix of body) if (!p.programs.includes(progOf(ix))) problems.push(`the ${p.kind} calls a program it must not (${progOf(ix)}).`);
  return { problems, body };
}

/** CreateIdempotent for exactly this owner, mint and token program, paid by the deposit. */
export function isAtaFor(ix, deposit, owner, mint, tokenProgram = P.token) {
  return (
    progOf(ix) === P.ata && Uint8Array.from(ix.data).length === 1 && Uint8Array.from(ix.data)[0] === 1 &&
    keyAt(ix, 0) === deposit && keyAt(ix, 1) === ataOf(mint, owner, tokenProgram) && keyAt(ix, 2) === owner && keyAt(ix, 3) === mint && keyAt(ix, 5) === tokenProgram
  );
}

/**
 * The wrap, the buy's place and the unwrap: [ata(deposit, WSOL), transfer(deposit -> its WSOL account, <= max), sync]
 * starting at body[i]. Returns the lamports wrapped, or pushes problems and returns null.
 */
export function checkWrap(body, i, deposit, maxLamports, problems) {
  const [open, move, sync] = body.slice(i, i + 3);
  const w = ataOf(WSOL, deposit);
  if (!open || !isAtaFor(open, deposit, deposit, WSOL)) problems.push("the first buy doesn't open the deposit's own wrapped-SOL account.");
  if (!move || progOf(move) !== P.system || keyAt(move, 0) !== deposit || keyAt(move, 1) !== w) {
    problems.push("the first buy's SOL doesn't go into the deposit's own wrapped-SOL account.");
    return null;
  }
  const lamports = decodeSystemTransfer(Uint8Array.from(move.data));
  if (lamports === null) problems.push("the wrap isn't a plain transfer.");
  else if (maxLamports == null || lamports > BigInt(maxLamports)) problems.push('the first buy could spend more than the person set.');
  if (!sync || progOf(sync) !== P.token || Uint8Array.from(sync.data).length !== 1 || Uint8Array.from(sync.data)[0] !== 17 || keyAt(sync, 0) !== w) problems.push("the wrapped SOL isn't synced.");
  return lamports;
}
/** The unwrap: close the deposit's own WSOL account back into the deposit. */
export function isUnwrap(ix, deposit) {
  const d = Uint8Array.from(ix.data);
  return progOf(ix) === P.token && d.length === 1 && d[0] === 9 && keyAt(ix, 0) === ataOf(WSOL, deposit) && keyAt(ix, 1) === deposit && keyAt(ix, 2) === deposit;
}

/** Borsh string at offset o: { value, next }. Throws on short data. */
export function readStr(b, o, max = 400) {
  if (o + 4 > b.length) throw new Error('decode: data too short');
  const n = b.readUInt32LE(o);
  if (n > max || o + 4 + n > b.length) throw new Error('decode: bad string');
  return { value: b.subarray(o + 4, o + 4 + n).toString('utf8'), next: o + 4 + n };
}
export const strBytes = (s) => {
  const v = Buffer.from(s, 'utf8');
  const n = Buffer.alloc(4);
  n.writeUInt32LE(v.length);
  return Buffer.concat([n, v]);
};
export const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
