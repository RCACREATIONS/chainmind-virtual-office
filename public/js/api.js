const CM = {
  token: localStorage.getItem('cm_token'),
  user: JSON.parse(localStorage.getItem('cm_user') || 'null'),

  logout() {
    localStorage.removeItem('cm_token');
    localStorage.removeItem('cm_user');
    window.location.href = 'index.html';
  },

  async call(endpoint, action, { method = 'GET', body = null, query = {} } = {}) {
    const params = new URLSearchParams({ action, token: this.token || '', ...query });
    let result;
    try {
      result = await cmFetchJson(`${endpoint}.php?${params}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: body ? JSON.stringify(body) : null,
      });
    } catch (error) {
      throw error;
    }
    const { response: res, data } = result;
    if (res.status === 401) {
      localStorage.setItem('cm_last_error', `${endpoint}.php?action=${action} → 401\n${JSON.stringify(data)}`);
      this.logout();
      return;
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
};