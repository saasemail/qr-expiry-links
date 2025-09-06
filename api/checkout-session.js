export const config = { runtime: 'edge' };

function rid(n = 8) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body; try { body = await req.json(); } catch {}
  const tier = Number(body?.tier || 0) || 0;
  const session_id = `sess_${tier}_${rid(12)}`;
  return new Response(JSON.stringify({ session_id }), { headers: { 'content-type': 'application/json' }});
}
