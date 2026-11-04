// Minimal helpdesk API client. Extend as needed.
export class HelpdeskClient {
  constructor({
    baseUrl = process.env.HELPDESK_URL || "http://localhost:4010",
    token = process.env.HELPDESK_TOKEN || "",
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  // GET a path (e.g. "/some/endpoint") with optional query params; returns parsed JSON.
  async get(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Helpdesk API GET ${url} failed: ${res.status} ${body}`);
    }
    return res.json();
  }
}
