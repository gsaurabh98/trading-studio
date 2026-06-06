"""Generate an Angel One SmartAPI session token for Trading Studio.

Usage (one-time setup):
    1. Register app at https://smartapi.angelone.in/new/apps
       - Redirect URL: http://127.0.0.1  (required field, unused for programmatic login)
       - Note down the API Key after creation.
    2. Enable TOTP at https://smartapi.angelone.in/enable-totp
       - Note the secret string below the QR code.
    3. Create data/angel-one-creds.json (gitignored) with your credentials:
       {
         "api_key": "YOUR_API_KEY",
         "client_code": "YOUR_CLIENT_ID",
         "pin": "YOUR_PIN",
         "totp_secret": "YOUR_TOTP_SECRET"
       }
    4. Run:  .venv/bin/python scripts/tools/angel-one-auth.py

The script generates a JWT token valid until 5 AM next day.
It writes the token into data/config.json under the "angel_one_token" key.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import TypedDict

try:
    import pyotp
except ImportError:
    sys.exit(
        "pyotp not installed. Run:\n"
        "  .venv/bin/pip install pyotp requests"
    )

try:
    import requests
except ImportError:
    sys.exit(
        "requests not installed. Run:\n"
        "  .venv/bin/pip install pyotp requests"
    )


# ─── Paths ───────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent.parent
CREDS_PATH = ROOT / "data" / "angel-one-creds.json"
CONFIG_PATH = ROOT / "data" / "config.json"

# ─── Angel One API ───────────────────────────────────────────────────────────

LOGIN_URL = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword"


class Credentials(TypedDict):
    api_key: str
    client_code: str
    pin: str
    totp_secret: str


class LoginResponse(TypedDict):
    jwtToken: str
    refreshToken: str
    feedToken: str


# ─── Helpers ─────────────────────────────────────────────────────────────────


def load_credentials() -> Credentials:
    """Read credentials from the local (gitignored) JSON file."""
    if not CREDS_PATH.exists():
        sys.exit(
            f"Credentials file not found at:\n  {CREDS_PATH}\n\n"
            "Create it with:\n"
            '  {"api_key": "...", "client_code": "...", "pin": "...", "totp_secret": "..."}'
        )
    raw: dict[str, str] = json.loads(CREDS_PATH.read_text())
    required = {"api_key", "client_code", "pin", "totp_secret"}
    missing = required - raw.keys()
    if missing:
        sys.exit(f"Missing keys in {CREDS_PATH.name}: {', '.join(sorted(missing))}")
    return Credentials(
        api_key=raw["api_key"],
        client_code=raw["client_code"],
        pin=raw["pin"],
        totp_secret=raw["totp_secret"],
    )


def generate_totp(secret: str) -> str:
    """Generate a time-based OTP from the TOTP secret."""
    totp = pyotp.TOTP(secret)
    return totp.now()


def login(creds: Credentials) -> LoginResponse:
    """Call Angel One login API and return tokens."""
    totp_code = generate_totp(creds["totp_secret"])

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": creds["api_key"],
    }

    payload = {
        "clientcode": creds["client_code"],
        "password": creds["pin"],
        "totp": totp_code,
    }

    resp = requests.post(LOGIN_URL, json=payload, headers=headers, timeout=10)
    resp.raise_for_status()
    body = resp.json()

    if not body.get("status"):
        error_msg = body.get("message", "Unknown error")
        error_code = body.get("errorcode", "")
        if error_code == "AB1050":
            print("TOTP invalid — retrying with fresh code in 30s...")
            time.sleep(30)
            return login(creds)
        sys.exit(f"Login failed: {error_msg} (code: {error_code})")

    data = body["data"]
    return LoginResponse(
        jwtToken=data["jwtToken"],
        refreshToken=data["refreshToken"],
        feedToken=data["feedToken"],
    )


def save_token(jwt_token: str) -> None:
    """Write the Angel One JWT into data/config.json (preserving other keys)."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    config: dict[str, str] = {}
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text())

    config["angel_one_token"] = jwt_token
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n")
    print(f"Token saved to {CONFIG_PATH.relative_to(ROOT)}")


# ─── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    print("Angel One SmartAPI — Token Generator")
    print("=" * 40)

    creds = load_credentials()
    print(f"Client: {creds['client_code']}")
    print("Generating TOTP and logging in...")

    tokens = login(creds)
    jwt = tokens["jwtToken"]

    save_token(jwt)

    print(f"\nJWT token (first 50 chars): {jwt[:50]}...")
    print("Valid until: ~5:00 AM tomorrow")
    print("\nYou can also paste this token into the app's API modal.")


if __name__ == "__main__":
    main()
