const encoder = new TextEncoder();
async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function createSession(secret) {
  const expires = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`owner:${expires}`));
  return `${expires}.${Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function isOwner(request, env) {
  if (!env.OWNER_KEY) return false;
  const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)pair_owner=([0-9]+)\.([0-9a-f]{64})(?:;|$)/);
  if (!cookie || Number(cookie[1]) < Date.now() || Number(cookie[1]) > Date.now() + 31 * 86400000) return false;
  const bytes = Uint8Array.from(cookie[2].match(/../g), x => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', await signingKey(env.OWNER_KEY), bytes, encoder.encode(`owner:${cookie[1]}`));
}
