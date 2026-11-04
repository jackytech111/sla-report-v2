"""Minimal helpdesk API client. Extend as needed."""

import os

import httpx


class HelpdeskClient:
    def __init__(self, base_url: str | None = None, token: str | None = None):
        self.base_url = (base_url or os.environ.get("HELPDESK_URL", "http://localhost:4010")).rstrip("/")
        self.token = token or os.environ.get("HELPDESK_TOKEN", "")

    def get(self, path: str, params: dict | None = None):
        """GET a path (e.g. "/some/endpoint") and return the parsed JSON.

        Raises httpx.HTTPStatusError on a non-2xx response.
        """
        response = httpx.get(
            self.base_url + path,
            params=params,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
            timeout=10.0,
        )
        response.raise_for_status()
        return response.json()
