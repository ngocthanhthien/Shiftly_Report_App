// Keep the existing backend as the compatibility endpoint for older devices.
// Service binding keeps API calls internal and preserves its existing secret.
async function authenticated(request, env) {
  if (!env.APP_USERNAME || !env.APP_PASSWORD) return false;
  const auth = request.headers.get('Authorization') || '';
  if (!/^Basic /i.test(auth)) return false;
  let decoded;
  try { decoded = atob(auth.slice(6).trim()); } catch { return false; }
  const encoder = new TextEncoder();
  // Compare fixed-size digests using the Workers constant-time primitive.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(decoded)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.APP_USERNAME + ':' + env.APP_PASSWORD))
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

export default {
  async fetch(request, env) {
    if (!await authenticated(request, env)) {
      return new Response('Vui lòng đăng nhập để mở Shiftly Report.', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="Shiftly Report", charset="UTF-8"',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }
    const url = new URL(request.url);
    const upstream = new Request(request);
    // The app login credential is not the backend sync credential.
    upstream.headers.delete('Authorization');
    let response;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/images/')) {
      response = await env.SYNC.fetch(upstream);
    } else {
      response = await env.ASSETS.fetch(upstream);
    }
    const protectedResponse = new Response(response.body, response);
    protectedResponse.headers.set('Cache-Control', 'private, no-store');
    protectedResponse.headers.set('Vary', 'Authorization');
    return protectedResponse;
  }
};
