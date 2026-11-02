// POST /api/upload  (body: one picture, Content-Type image/png | image/jpeg | image/webp | image/gif)
//   -> {ok, url, width, height}   the picture, checked and re-encoded, stored for the art to use as a reference
// The "+" in the prompt box sends each attached picture here first; /api/make then gets the URLs. Only real pixels
// get through (images.js reads them with sharp, whatever the name or type says), at most 4.5 MB in and 1536 px a side
// out, as a fresh JPEG with no metadata. Stored public (the image model reads it from there) under a random name.
// A few per IP: 24 an hour, 4 in any 10 seconds (per instance; nothing here spends money but storage).
import { ImageError, normalize } from './_lib/images.js';
import { clientIp, fail, limited, ok } from './_lib/http.js';
import { hasStore, putUpload } from './_lib/store.js';

// Vercel turns away a function's request body over 4.5 MB before it gets here (FUNCTION_PAYLOAD_TOO_LARGE), so the
// page shrinks a big picture before it sends it (app.js shrinkPicture); this is the same limit, said in our words.
const MAX_BYTES = 4_500_000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const log = (o) => console.log(JSON.stringify({ at: 'upload', ...o }));
const sameOrigin = (req) => {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
};

export async function POST(req) {
  if (!sameOrigin(req)) return fail('cross_site', 403);
  if (!hasStore()) return fail('off', 503);
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES.has(type)) return fail('bad_file', 415);
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return fail('file_too_big', 413);
  const ip = clientIp(req);
  if (limited(`up:${ip}`, 24, 3600_000) || limited(`upburst:${ip}`, 4, 10_000)) return fail('slow', 429);

  let body;
  try {
    body = Buffer.from(await req.arrayBuffer());
  } catch {
    return fail('bad_file');
  }
  if (body.length > MAX_BYTES) return fail('file_too_big', 413);
  if (body.length < 100) return fail('bad_file');
  let img;
  try {
    img = await normalize(body, { max: 1536, quality: 90 });
  } catch (e) {
    log({ ok: false, why: String(e?.message ?? e).slice(0, 120) });
    return fail(e instanceof ImageError && e.code === 'too_big' ? 'file_too_big' : 'bad_file', 415);
  }
  try {
    const { url } = await putUpload(img.data);
    log({ ok: true, bytes: body.length, out: img.data.length, w: img.width, h: img.height });
    return ok({ url, width: img.width, height: img.height });
  } catch (e) {
    log({ ok: false, storage: String(e?.message ?? e).slice(0, 160) });
    return fail('off', 503);
  }
}
