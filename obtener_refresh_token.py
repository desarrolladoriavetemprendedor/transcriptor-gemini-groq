"""Genera un refresh token de Google Drive para el servidor web.

Uso:
    python obtener_refresh_token.py client_secret.json
"""

from __future__ import annotations

import sys

from google_auth_oauthlib.flow import InstalledAppFlow


SCOPES = ["https://www.googleapis.com/auth/drive"]


if len(sys.argv) != 2:
    raise SystemExit("Uso: python obtener_refresh_token.py client_secret.json")

flow = InstalledAppFlow.from_client_secrets_file(sys.argv[1], SCOPES)
credentials = flow.run_local_server(port=0, access_type="offline", prompt="consent")
print("GOOGLE_CLIENT_ID=" + credentials.client_id)
print("GOOGLE_CLIENT_SECRET=" + credentials.client_secret)
print("GOOGLE_REFRESH_TOKEN=" + credentials.refresh_token)
