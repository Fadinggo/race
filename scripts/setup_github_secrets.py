#!/usr/bin/env python3
"""One-time, opt-in Actions secret provisioning for Fadinggo/race from Grok.

Dependency: python -m pip install 'PyNaCl==1.6.2'
Dry run:    python scripts/setup_github_secrets.py
Apply:      python scripts/setup_github_secrets.py --apply

Set RACE_GITHUB_SETUP_TOKEN through the cloud's secret environment mechanism;
never place it in a command line or file. Use a short-lived fine-grained PAT
restricted to Fadinggo/race, with repository Secrets: read and write only
(Metadata: read is automatic). Contents permission is not needed. Revoke the
temporary PAT after setup. This program cannot prove token scope locally.

The three OKX_A_* environment variables map to same-named Actions secrets.
OKX_API_KEY, OKX_SECRET_KEY, and OKX_PASSPHRASE map respectively to
OKX_B_API_KEY, OKX_B_SECRET_KEY, and OKX_B_PASSPHRASE in Actions, matching the
workflow's explicit mapping back to collector environment variables.
An independent 32-byte state key is stored as hex outside the repository at
/workspace/race-sync/private/github-state.key. A retry reuses it unchanged;
an invalid, insecure, or unreadable existing key is never replaced. Apply must
run on POSIX; dry-run performs no network calls and creates no files.

Seven PUTs are not transactional. A failed apply may have set some secrets;
rerun with the same environment and retained state key to complete it.

Official references:
https://docs.github.com/en/rest/actions/secrets#get-a-repository-public-key
https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret
https://docs.github.com/en/rest/guides/encrypting-secrets-for-the-rest-api
https://pynacl.readthedocs.io/en/latest/public/#nacl-public-sealedbox
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import sys
from urllib import error, request


REPOSITORY = "Fadinggo/race"
API_BASE = "https://api.github.com/repos/Fadinggo/race/actions/secrets"
PUBLIC_KEY_URL = API_BASE + "/public-key"
TOKEN_ENV = "RACE_GITHUB_SETUP_TOKEN"
SECRET_ENV = {
    "OKX_A_API_KEY": "OKX_A_API_KEY",
    "OKX_A_SECRET_KEY": "OKX_A_SECRET_KEY",
    "OKX_A_PASSPHRASE": "OKX_A_PASSPHRASE",
    "OKX_B_API_KEY": "OKX_API_KEY",
    "OKX_B_SECRET_KEY": "OKX_SECRET_KEY",
    "OKX_B_PASSPHRASE": "OKX_PASSPHRASE",
}
OKX_SECRET_NAMES = tuple(SECRET_ENV)
SECRET_NAMES = OKX_SECRET_NAMES + ("DASHBOARD_STATE_KEY",)
STATE_KEY_PATH = Path("/workspace/race-sync/private/github-state.key")
TIMEOUT_SECONDS = 20
API_VERSION = "2026-03-10"


class SetupError(Exception):
    """Contains a fixed, non-sensitive error code only."""


class NoRedirects(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SetupError("github_redirect_refused") from None


def validate_environment(environment):
    values = {}
    for name, source_name in SECRET_ENV.items():
        value = environment.get(source_name)
        if not isinstance(value, str) or not value.strip():
            raise SetupError("missing_okx_environment")
        if len(value.encode("utf-8")) > 48000 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise SetupError("invalid_okx_environment")
        values[name] = value
    if secrets.compare_digest(values["OKX_A_API_KEY"].strip().encode(), values["OKX_B_API_KEY"].strip().encode()):
        raise SetupError("account_api_keys_must_differ")
    token = environment.get(TOKEN_ENV)
    if (not isinstance(token, str) or not token.startswith("github_pat_")
            or not re.fullmatch(r"github_pat_[A-Za-z0-9_]+", token)):
        raise SetupError("fine_grained_setup_token_required")
    return values, token


def require_posix():
    if os.name != "posix":
        raise SetupError("apply_requires_posix_private_permissions")


def validate_private_metadata(info, mode, *, directory=False):
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise SetupError("state_key_path_not_regular")
    if os.name == "posix" and (stat.S_IMODE(info.st_mode) != mode or info.st_uid != os.geteuid()):
        raise SetupError("state_key_permissions_or_owner_invalid")
    if not directory and info.st_nlink != 1:
        raise SetupError("state_key_hardlink_refused")


def load_or_create_state_key(path=STATE_KEY_PATH):
    """Private POSIX file; O_EXCL never overwrites or silently rotates a key."""
    require_posix()
    path = Path(path)
    try:
        if not path.is_absolute() or any(parent.is_symlink() for parent in (path, *path.parents)):
            raise SetupError("state_key_symlink_or_relative_path_refused")
        if any((parent / ".git").exists() for parent in path.parents):
            raise SetupError("state_key_inside_git_checkout")
        path.parent.mkdir(mode=0o700, exist_ok=True)
        validate_private_metadata(path.parent.lstat(), 0o700, directory=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags, 0o600)
        except FileExistsError:
            descriptor = None
        if descriptor is not None:
            with os.fdopen(descriptor, "wb") as output:
                validate_private_metadata(os.fstat(output.fileno()), 0o600)
                output.write(secrets.token_bytes(32).hex().encode("ascii") + b"\n")
                output.flush()
                os.fsync(output.fileno())
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as source:
            validate_private_metadata(os.fstat(source.fileno()), 0o600)
            encoded = source.read(66)
        if not re.fullmatch(rb"[0-9a-fA-F]{64}\n?", encoded):
            raise SetupError("existing_state_key_invalid_do_not_replace")
        return encoded.rstrip(b"\n").decode("ascii")
    except SetupError:
        raise
    except (OSError, ValueError, UnicodeError):
        raise SetupError("private_state_key_io_failed") from None


class GitHubSecretsClient:
    def __init__(self, token, *, opener=None):
        self._token = token
        self._opener = opener or request.build_opener(
            request.ProxyHandler({}),  # Never send credentials through an env-supplied proxy.
            request.HTTPSHandler(context=ssl.create_default_context()), NoRedirects())

    def _request(self, method, url, body=None):
        allowed = ((method == "GET" and url == PUBLIC_KEY_URL and body is None)
                   or (method == "PUT" and url in {API_BASE + "/" + name for name in SECRET_NAMES}
                       and isinstance(body, dict) and set(body) == {"encrypted_value", "key_id"}))
        if not allowed:
            raise SetupError("github_request_outside_allowlist")
        headers = {"Accept": "application/vnd.github+json", "Authorization": "Bearer " + self._token,
                   "X-GitHub-Api-Version": API_VERSION, "User-Agent": "race-secret-setup"}
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = request.Request(url, data=payload, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=TIMEOUT_SECONDS) as response:
                if response.geturl() != url:
                    raise SetupError("github_redirect_refused")
                if response.status not in ((200,) if method == "GET" else (201, 204)):
                    raise SetupError("github_unexpected_status")
                if method == "PUT":
                    return None  # Never read or log response bodies from writes.
                raw = response.read(16385)
                if len(raw) > 16384:
                    raise SetupError("github_public_key_response_invalid")
                return json.loads(raw)
        except SetupError:
            raise
        except error.HTTPError as failure:
            failure.close()  # Do not read an error body, reason, URL, or headers.
            raise SetupError("github_http_error") from None
        except (error.URLError, OSError, ValueError, UnicodeError):
            raise SetupError("github_request_or_response_failed") from None

    def public_key(self):
        document = self._request("GET", PUBLIC_KEY_URL)
        if (not isinstance(document, dict) or not isinstance(document.get("key_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9_=-]{1,200}", document["key_id"])
                or not isinstance(document.get("key"), str)):
            raise SetupError("github_public_key_response_invalid")
        try:
            if len(base64.b64decode(document["key"], validate=True)) != 32:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise SetupError("github_public_key_response_invalid") from None
        return document["key_id"], document["key"]

    def put_secret(self, name, encrypted_value, key_id):
        if name not in SECRET_NAMES:
            raise SetupError("github_request_outside_allowlist")
        self._request("PUT", API_BASE + "/" + name,
                      {"encrypted_value": encrypted_value, "key_id": key_id})


def seal_value(public_key, value):
    try:
        from nacl import encoding, public
    except ImportError:
        raise SetupError("pynacl_dependency_missing") from None
    try:
        key = public.PublicKey(public_key.encode("ascii"), encoding.Base64Encoder())
        encrypted = public.SealedBox(key).encrypt(value.encode("utf-8"))
        return base64.b64encode(encrypted).decode("ascii")
    except Exception:
        raise SetupError("secret_encryption_failed") from None


def setup(environment, *, apply=False, state_path=STATE_KEY_PATH, client_factory=GitHubSecretsClient):
    values, token = validate_environment(environment)
    if not apply:
        return "dry_run"
    # Resolve the dependency before creating state or making any request.
    try:
        from nacl import public  # noqa: F401
    except ImportError:
        raise SetupError("pynacl_dependency_missing") from None
    values["DASHBOARD_STATE_KEY"] = load_or_create_state_key(state_path)
    client = client_factory(token)
    key_id, public_key = client.public_key()
    # Encrypt the entire batch before the first write, so an encryption error
    # cannot leave a partially configured repository.
    encrypted = {name: seal_value(public_key, values[name]) for name in SECRET_NAMES}
    for name in SECRET_NAMES:
        client.put_secret(name, encrypted[name], key_id)
    return "applied"


def main(argv=None, *, environment=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Write exactly seven Actions secrets; default is dry run.")
    args = parser.parse_args(argv)
    try:
        result = setup(os.environ if environment is None else environment, apply=args.apply)
    except SetupError as failure:
        print("Setup failed: " + str(failure), file=sys.stderr)
        return 1
    except Exception:
        print("Setup failed: unexpected_setup_failure", file=sys.stderr)
        return 1
    print(result + ": " + REPOSITORY)
    for name in SECRET_NAMES:
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
