// Fetching from the open web without letting a stranger point the server at itself. Used for the original pictures of
// memes and characters (refs.js) and for nothing else. Every hop of a request is checked: http(s) only, the default
// ports only, no user:password in the URL, and the address a name resolves to must be public (checked inside the
// connection's own DNS lookup, so a name can't resolve to a public address for the check and a private one for the
// connection). Bodies are capped while they stream and every request has a deadline.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';

export const UA = 'wagbi/1.0 (+https://wagbi.fun; finds the original picture of a meme for a coin kit)';

const v4 = (ip) => ip.split('.').map(Number);
function publicV4(ip) {
  const [a, b, c] = v4(ip);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this net, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}
/** True for a public unicast address; false for anything private, local, reserved or malformed. */
export function isPublicIp(ip) {
  const kind = net.isIP(String(ip || ''));
  if (kind === 4) return publicV4(ip);
  if (kind !== 6) return false;
  const s = ip.toLowerCase();
  // an IPv4 address wrapped in IPv6 (::ffff:1.2.3.4, or NAT64 64:ff9b::1.2.3.4): judge the IPv4 one
  const tail = /(?:^::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) return publicV4(tail[1]);
  if (/^::ffff:/.test(s) || /^64:ff9b:/.test(s)) return false;
  if (s === '::' || s === '::1') return false;
  const head = parseInt(s.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((head & 0xffc0) === 0xfe80) return false; // link local fe80::/10
  if ((head & 0xff00) === 0xff00) return false; // multicast
  if (s.startsWith('2001:db8:') || s.startsWith('2001:0db8:')) return false; // documentation
  if (s.startsWith('100::') || s.startsWith('0100:')) return false; // discard prefix
  // 6to4 (2002::/16) and Teredo (2001:0::/32) carry an IPv4 address inside: never judged as public
  if (head === 0x2002 || /^2001:0{0,4}:/.test(s)) return false;
  return (head & 0xe000) === 0x2000; // global unicast is 2000::/3
}

/** The URL if it may be fetched (http(s), default port, no credentials, a host that isn't an IP outside the public internet), else null. */
export function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/i.test(host)) return null;
  if (net.isIP(host) && !isPublicIp(host)) return null;
  if (!net.isIP(host) && !host.includes('.')) return null; // single-label names resolve inside networks
  if (u.href.length > 2048) return null;
  return u;
}

// the connection's own DNS lookup: every address the name resolves to must be public
function safeLookup(hostname, options, cb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [];
    if (!list.length || list.some((a) => !isPublicIp(a.address))) return cb(Object.assign(new Error('not a public address'), { code: 'EBLOCKED' }));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export class FetchError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function once(u, { headers, timeoutMs, maxBytes, signal, lookup = safeLookup }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    let hard = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      fn(v);
    };
    const req = mod.get(u, { lookup, headers, timeout: timeoutMs, signal }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done(resolve, { redirect: res.headers.location, status });
      }
      if (status !== 200) {
        res.resume();
        return done(reject, new FetchError(`HTTP ${status}`, 'status'));
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) {
        res.destroy();
        return done(reject, new FetchError('too big', 'too_big'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          done(reject, new FetchError('too big', 'too_big'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, { status, type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks) }));
      res.on('error', (e) => done(reject, new FetchError(String(e?.message ?? e), 'network')));
      res.on('close', () => done(reject, new FetchError('the connection closed early', 'network')));
    });
    // `timeout` above is an idle timeout: a server that sends a byte every few seconds never trips it. This is the
    // whole request's deadline (the lookup, the connection, the headers and every byte of the body).
    hard = setTimeout(() => {
      req.destroy();
      done(reject, new FetchError('timed out', 'timeout'));
    }, Math.max(1, timeoutMs));
    req.on('timeout', () => req.destroy(new FetchError('timed out', 'timeout')));
    req.on('error', (e) => done(reject, e instanceof FetchError ? e : new FetchError(String(e?.message ?? e), e?.code === 'EBLOCKED' ? 'blocked' : signal?.aborted ? 'aborted' : 'network')));
  });
}

/** For tests only: one request against a local server (safeGet itself always checks every address). */
export const _once = (url, o) => once(new URL(url), { headers: {}, maxBytes: 1_000_000, timeoutMs: 1000, ...o });

/**
 * GETs a public URL: { url (after redirects), type (the content type), body (Buffer) }. Throws FetchError
 * ('bad_url', 'blocked', 'status', 'too_big', 'timeout', 'network', 'redirects').
 */
export async function safeGet(raw, { maxBytes = 8_000_000, timeoutMs = 9000, accept = '*/*', redirects = 3, signal } = {}) {
  let u = checkUrl(raw);
  if (!u) throw new FetchError('not a fetchable url', 'bad_url');
  const until = Date.now() + timeoutMs;
  for (let hop = 0; hop <= redirects; hop++) {
    const left = until - Date.now();
    if (left <= 0) throw new FetchError('timed out', 'timeout');
    const r = await once(u, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' }, timeoutMs: left, maxBytes, signal });
    if (!r.redirect) return { url: u.href, type: r.type, body: r.body };
    const next = checkUrl(new URL(r.redirect, u).href);
    if (!next) throw new FetchError('redirect to a url that may not be fetched', 'blocked');
    u = next;
  }
  throw new FetchError('too many redirects', 'redirects');
}
