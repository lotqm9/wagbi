// The deposit keys, for every launchpad. Server only.
//
// printer-engine's Custody makes and seals the keys (unchanged: AES-256-GCM under a key derived from the master key,
// the deposit's id and address bound in). Its DepositSigner only knows pump.fun's SOL rules, so this file opens the
// same sealed keys (the same format, byte for byte; test/launch-pads.test.mjs seals with the engine and opens here)
// into a signer that picks the guard for the launchpad the transaction is for:
//   no `guard` in the policy (pump.fun on SOL, and every sweep back to the payout wallet) -> the engine's own
//   checkDepositTx, exactly as before;
//   `guard: <id>` -> that launchpad adapter's checkTx, plus: the extra signers handed in are exactly the fresh keys
//   the policy names (a key Bags already signed with is named but not handed in).
// A transaction any guard refuses is never signed. Nothing here logs, returns or serializes a secret.
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { inspect } from 'node:util';
import { Keypair } from '@solana/web3.js';
import { Custody, CustodyError, GuardRefused, checkDepositTx } from 'printer-engine/launch';

const SALT = Buffer.from('brrrr/deposits/v1');
const aad = (depositId, address) => Buffer.from(`brrrr-deposit|v1|${depositId}|${address}`);

function wipe(kp) {
  try {
    kp?._keypair?.secretKey?.fill(0);
  } catch {
    /* nothing to wipe */
  }
}

export class LaunchCustody {
  #key;
  #engine;
  #guards;
  /** master: the 32 bytes of WAGBI_DEPOSIT_MASTER_KEY. guards: { [guard id]: (tx, policy) -> problems[] }. */
  constructor(master, guards = {}) {
    this.#engine = new Custody(master);
    this.#key = Buffer.from(hkdfSync('sha256', master, SALT, 'deposit-secret-key', 32));
    this.#guards = guards;
    this.kid = this.#engine.kid;
  }
  newDepositKey(depositId) {
    return this.#engine.newDepositKey(depositId);
  }
  signer(sealed, depositId, address) {
    if (sealed?.v !== 1 || sealed.alg !== 'A256GCM') throw new CustodyError('unknown sealed key format');
    if (sealed.kid !== this.kid) throw new CustodyError('this deposit was sealed with another master key');
    let secret;
    try {
      const d = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(sealed.iv, 'base64'));
      d.setAAD(aad(depositId, address));
      d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      secret = Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]);
    } catch {
      throw new CustodyError("the sealed key didn't open (wrong master key, or it was changed)");
    }
    try {
      if (secret.length !== 64) throw new CustodyError('the sealed key is not a Solana secret key');
      const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
      if (kp.publicKey.toBase58() !== address) {
        wipe(kp);
        throw new CustodyError("the sealed key is not this deposit's key");
      }
      return new LaunchSigner(kp, this.#guards);
    } finally {
      secret.fill(0);
    }
  }
  toJSON() {
    return '[custody: redacted]';
  }
  [inspect.custom]() {
    return '[custody: redacted]';
  }
}

export class LaunchSigner {
  #kp;
  #guards;
  constructor(kp, guards) {
    this.#kp = kp;
    this.#guards = guards;
    this.address = kp.publicKey.toBase58();
  }
  /** The problems a transaction has under its policy's guard ([] means it may be signed). */
  check(tx, policy, extra = []) {
    const p = { ...policy, deposit: this.address };
    if (!policy.guard) {
      const problems = checkDepositTx(tx, p);
      if (extra.some((k) => k.publicKey.toBase58() !== policy.mint)) problems.push("an extra signer isn't the coin's mint.");
      return problems;
    }
    const guard = this.#guards[policy.guard];
    if (!guard) return [`there is no guard for ${policy.guard}.`];
    let problems;
    try {
      problems = guard(tx, p);
    } catch (e) {
      problems = [`the guard couldn't read it (${String(e?.message ?? e).slice(0, 80)}).`]; // fails closed
    }
    const want = (policy.signers ?? []).filter((k) => !(policy.presigned ?? []).includes(k)).sort().join();
    if (extra.map((k) => k.publicKey.toBase58()).sort().join() !== want) problems.push("the extra signers aren't the fresh keys the launch made.");
    return problems;
  }
  sign(tx, policy, extra = []) {
    if (!this.#kp) throw new CustodyError('this deposit signer was retired');
    const problems = this.check(tx, policy, extra);
    if (problems.length) throw new GuardRefused(problems);
    tx.sign([this.#kp, ...extra]);
  }
  retire() {
    wipe(this.#kp);
    this.#kp = null;
  }
  toJSON() {
    return { depositSigner: this.address, secret: '[redacted]' };
  }
  [inspect.custom]() {
    return `LaunchSigner(${this.address}, secret redacted)`;
  }
}
