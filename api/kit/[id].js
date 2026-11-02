// GET /api/kit/:id  ->  {ok, kit: {id, sentence, name, ticker, bio, style, logo, banner, logoSvg, bannerSvg, root?, version?, ask?, ...}}
// The image fields are public Blob urls. A kit never changes once stored, so a found one caches for good.
// ?versions=1 also answers the coin's conversation: {versions: [{version, kitId, ask, parent, at}]}, oldest first,
// and the latest version's kit as `latest` (both change as the coin is edited, so they cache briefly).
// ?turn=1 answers how a message's turn ended, by its first kit id (the page that lost its stream asks):
// {turn: {ok, reply, kits, code?, error?, at}} once it is over, {turn: null} while it runs.
import { clientIp, fail, limited, ok } from '../_lib/http.js';
import { hasStore, isId, readKit, readTurn, versionsOf } from '../_lib/store.js';

export async function GET(req) {
  const u = new URL(req.url);
  const id = decodeURIComponent(u.pathname.split('/').pop() || '');
  if (!isId(id)) return fail('not_found', 404);
  if (limited(`kit:${clientIp(req)}`, 120, 60_000)) return fail('slow', 429);
  if (!hasStore()) return fail('off', 503);
  if (u.searchParams.get('turn') === '1') {
    try {
      return ok({ turn: await readTurn(id) });
    } catch {
      return fail('off', 503);
    }
  }
  try {
    const kit = await readKit(id);
    if (!kit) return fail('not_found', 404);
    if (u.searchParams.get('versions') !== '1') return ok({ kit }, 'public, max-age=300, s-maxage=31536000, immutable');
    const versions = await versionsOf(kit.root || kit.id);
    const lastId = versions.at(-1)?.kitId;
    const latest = lastId && lastId !== kit.id ? await readKit(lastId) : kit;
    return ok({ kit, versions, latest }, 'public, max-age=5, s-maxage=5');
  } catch {
    return fail('off', 503);
  }
}
