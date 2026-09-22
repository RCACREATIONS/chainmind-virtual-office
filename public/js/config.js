// ChainMind Team Portal — frontend config
// Point this at your deployed PHP backend. There's no separate realtime
// server to configure anymore — presence, movement, and call signaling all
// go through backend/api/realtime.php on the same PHP host (see README).
window.CM_CONFIG = {
  // This matches the extracted deployment path:
  // https://chainmind.com.ng/chainmind_portal/backend/api/
  API_BASE: 'https://chainmind.com.ng/chainmind_portal/backend/api',
  THEME: {
    purple: '#6B21A8',
    purpleLight: '#8B3FD1',
    purpleDark: '#4C1D7A',
    bg: '#F5F3FF',
  },
};

/**
 * Return the configured API first, followed by the two deployment paths that
 * have existed for this portal. This lets a stale or copied config recover
 * after the portal is moved without making users edit browser storage.
 */
window.cmApiBases = function cmApiBases() {
  const origin = window.location.origin;
  const configured = String(window.CM_CONFIG.API_BASE || '').replace(/\/+$/, '');
  return [...new Set([
    configured,
    `${origin}/chainmind_portal/backend/api`,
    `${origin}/backend/api`,
  ].filter(Boolean))];
};

/**
 * Fetch and decode a JSON API response. An HTML 404/403 is treated as a
 * wrong-base signal, so the next known API base is tried automatically.
 */
window.cmFetchJson = async function cmFetchJson(path, init = {}) {
  let lastHtmlResponse = null;
  let lastNetworkError = null;
  const cleanPath = String(path).replace(/^\/+/, '');

  for (const base of window.cmApiBases()) {
    const url = `${base}/${cleanPath}`;
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      let data;

      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (/^\s*</.test(text) || response.status === 403 || response.status === 404) {
          lastHtmlResponse = { response, url };
          continue;
        }
        const error = new Error(`The portal API returned invalid JSON (${response.status}). Check the PHP server error log.`);
        error.status = response.status;
        throw error;
      }

      // Once a candidate returns JSON, keep it for realtime and later calls.
      window.CM_CONFIG.API_BASE = base;
      return { response, data, url };
    } catch (error) {
      if (error.status) throw error;
      lastNetworkError = error;
    }
  }

  if (lastHtmlResponse) {
    const error = new Error(
      `The portal API returned an HTML page instead of JSON (${lastHtmlResponse.response.status}). ` +
      `Upload backend beside public, or set API_BASE in public/js/config.js to the real /backend/api URL.`
    );
    error.status = lastHtmlResponse.response.status;
    throw error;
  }

  throw new Error(
    `Cannot reach the portal API at ${window.CM_CONFIG.API_BASE}. ` +
    `Check that PHP is online and API_BASE is correct. ${lastNetworkError?.message || ''}`.trim()
  );
};
