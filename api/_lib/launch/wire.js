// The launch, wired for this deployment (brrrr's lib/server/launch.ts, the same pieces, for wagbi).
//   deposits: the PRIVATE Blob store "wagbi-deposits" (WAGBI_DEPOSITS_READ_WRITE_TOKEN, added when the store was
//             connected with the prefix WAGBI_DEPOSITS), never the public kits store,
//             one prefix per cluster and environment (mainnet/prod/, devnet/preview/, ...)
//   keys:     sealed with WAGBI_DEPOSIT_MASTER_KEY (32 random bytes, base64). Missing: launches stay closed.
//             Opened by custody.js, which signs through each launchpad's own guard (launchpads.js GUARDS).
//   BAGS_API_KEY: handed to the Bags adapter only (it goes in Bags' x-api-key header, nowhere else)
//   kits, metadata and launched coins: the public kits store (store.js)
// Nothing here reads, logs or returns a secret: the custody and its signers print as [redacted].
import { Connection } from '@solana/web3.js';
import { DepositStore, parseMasterKey, publicChecker } from 'printer-engine/launch';
import { BlobObjectStore } from 'printer-engine/blob';
import { hasStore, putMeta, readKit, readLaunch, writeLaunch } from '../store.js';
import { createLaunchService } from './service.js';
import { LaunchCustody } from './custody.js';
import { GUARDS } from './launchpads.js';
import { depositPrefix, settingsFromEnv } from './settings.js';

const log = (e) => console.log(JSON.stringify({ at: 'launch', ...e }));

function custodyFromEnv(env) {
  try {
    const master = parseMasterKey(env.WAGBI_DEPOSIT_MASTER_KEY);
    return master ? new LaunchCustody(master, GUARDS) : null;
  } catch (e) {
    log({ evt: 'launch.config', problem: e.message }); // the parser's message never contains the key
    return null;
  }
}

let svc = null;
/** The launch service for this instance (built once). */
export function launchService(env = process.env) {
  if (svc) return svc;
  const settings = settingsFromEnv(env);
  const token = (env.WAGBI_DEPOSITS_READ_WRITE_TOKEN || env.WAGBI_DEPOSITS_BLOB_TOKEN)?.trim();
  const store = token && hasStore() ? new DepositStore(new BlobObjectStore({ access: 'private', token }), depositPrefix(settings.cluster, env)) : null;
  const check = publicChecker();
  svc = createLaunchService({
    rpc: new Connection(settings.rpcUrl, 'confirmed'),
    store,
    custody: custodyFromEnv(env),
    getKit: readKit,
    putMeta,
    readCoin: (kitId) => readLaunch(kitId, settings.cluster),
    writeCoin: writeLaunch,
    settings,
    // devnet test deployments sit behind Vercel's login, so only the metadata and the picture are read back
    checkPublic: settings.cluster === 'mainnet' ? check : (i, signal) => check({ ...i, website: i.imageUrl }, signal),
    log,
    secrets: { bagsKey: env.BAGS_API_KEY?.trim() || null },
  });
  return svc;
}
