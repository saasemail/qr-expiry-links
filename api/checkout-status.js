export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const sid = searchParams.get('session_id') || '';
  const token = `PRO-${sid.slice(-10).toUpperCase()}`;
  return new Response(JSON.stringify({ ready: true, token }), {
    headers: { 'content-type': 'application/json' }
  });
}
