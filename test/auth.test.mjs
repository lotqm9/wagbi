// Sign in with Google and chat sync, offline: the ID token check against a stand-in for Google's keys (a local RSA
// key), the session cookie, and how two devices' chats merge. No network.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _resetKeys, accountKey, sessionCookie, sessionOf, verifyGoogleIdToken } from '../api/_lib/auth.js';
import { mergeChats } from '../api/_lib/users.js';

const CLIENT = '1234-test.apps.googleusercontent.com';
const SECRET = 'x'.repeat(40);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fetchJson = async () => ({ body: { keys: [jwk] }, maxAge: 3600 });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims, o = {}) {
  const head = b64u({ alg: 'RS256', kid: o.kid ?? 'k1', typ: 'JWT' });
  const body = b64u(claims);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), o.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const now = Date.now();
const good = { iss: 'https://accounts.google.com', aud: CLIENT, sub: '1100', email: 'a@b.co', email_verified: true, name: 'a', exp: Math.floor(now / 1000) + 600 };

describe('the Google ID token', () => {
  it('passes a token signed by the listed key, for our client, from Google, not expired', async () => {
    _resetKeys();
    const c = await verifyGoogleIdToken(token(good), CLIENT, { fetchJson, now });
    assert.equal(c.sub, '1100');
  });
  it('refuses another audience, another issuer, an expired token, an unknown key and a forged signature', async () => {
    _resetKeys();
    const cases = [
      [token({ ...good, aud: 'someone-else' }), /audience/],
      [token({ ...good, iss: 'https://evil.example' }), /issuer/],
      [token({ ...good, exp: Math.floor(now / 1000) - 3600 }), /expired/],
      [token(good, { kid: 'nope' }), /unknown key/],
      [token(good, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /signature/],
      ['not.a.token', /./],
    ];
    for (const [t, re] of cases) await assert.rejects(verifyGoogleIdToken(t, CLIENT, { fetchJson, now }), re);
  });
});

describe('the session cookie', () => {
  const req = (cookie) => ({ headers: { get: (k) => (k === 'cookie' ? cookie : null) } });
  it('round-trips, is HttpOnly + Secure, and a changed byte or another secret is no session', () => {
    const set = sessionCookie(SECRET, { sub: '1100', email: 'a@b.co' }, now);
    assert.match(set, /HttpOnly; Secure; SameSite=Lax/);
    const value = set.split(';')[0];
    assert.equal(sessionOf(req(value), SECRET, now).sub, '1100');
    assert.equal(sessionOf(req(value.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))), SECRET, now), null);
    assert.equal(sessionOf(req(value), 'y'.repeat(40), now), null);
    assert.equal(sessionOf(req(value), SECRET, now + 31 * 86_400_000), null);
  });
  it('keys storage on a hash of the account, never the raw id', () => {
    const k = accountKey(SECRET, '1100');
    assert.ok(!k.includes('1100'));
    assert.equal(k, accountKey(SECRET, '1100'));
  });
});

describe('merging two devices', () => {
  const chat = (id, t, turns = 1) => ({ id, sentence: 's ' + id, t, kit: 'K'.repeat(16), turns: Array.from({ length: turns }, (_, i) => ({ v: i + 1 })) });
  it('keeps every chat from both, the further-along copy of a shared one, newest first', () => {
    const m = mergeChats({ chats: [chat('aaaa', 1), chat('bbbb', 5, 1)], deleted: {} }, [chat('bbbb', 4, 3), chat('cccc', 9)]);
    assert.deepEqual(m.chats.map((c) => c.id), ['cccc', 'bbbb', 'aaaa']);
    assert.equal(m.chats.find((c) => c.id === 'bbbb').turns.length, 3);
  });
  it('a chat deleted on one device stays deleted, unless it changed after the delete', () => {
    const m = mergeChats({ chats: [chat('aaaa', now - 5000), chat('bbbb', now + 5000)], deleted: {} }, [], { aaaa: now, bbbb: now });
    assert.deepEqual(m.chats.map((c) => c.id), ['bbbb']);
    const again = mergeChats(m, [chat('aaaa', now - 5000)]);
    assert.ok(!again.chats.some((c) => c.id === 'aaaa'));
  });
  it('drops anything that is not a chat record, and a make still running on a device', () => {
    const m = mergeChats({ chats: [], deleted: {} }, [{ id: 'x' }, 'nope', { ...chat('dddd', 1), pending: { ask: 'a' } }]);
    assert.deepEqual(m.chats.map((c) => c.id), ['dddd']);
    assert.equal(m.chats[0].pending, undefined);
  });
});
