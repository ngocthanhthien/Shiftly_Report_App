// Keep the existing backend as the compatibility endpoint for older devices.
// Service binding keeps API calls internal and preserves its existing secret.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/images/')) {
      return env.SYNC.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
