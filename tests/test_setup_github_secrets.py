"""Offline secret setup tests. All credentials and keys here are disposable fakes."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib import error

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import setup_github_secrets as setup
try:
    from nacl import public
except ImportError:
    public = None  # Routine Actions runs do not need this one-time setup dependency.


def fake_environment():
    return {**{name: "FAKE_TEST_VALUE_" + name for name in setup.SECRET_ENV.values()},
            setup.TOKEN_ENV: "github_pat_FAKE_TEST_SETUP_TOKEN_NOT_REAL"}


class FakeResponse:
    def __init__(self, url, status, payload=None):
        self.url, self.status, self.payload = url, status, payload
        self.read_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def geturl(self):
        return self.url

    def read(self, size):
        self.read_calls += 1
        return json.dumps(self.payload).encode()[:size]


class FakeNetwork:
    def __init__(self):
        self.private_key = public.PrivateKey.generate() if public is not None else None
        self.calls = []
        self.responses = []

    def open(self, req, *, timeout):
        self.calls.append((req, timeout))
        if req.method == "GET":
            result = FakeResponse(req.full_url, 200, {"key_id": "TEST_KEY_ID", "key":
                base64.b64encode(bytes(self.private_key.public_key) if self.private_key else bytes(range(32))).decode()})
        else:
            result = FakeResponse(req.full_url, 201 if len(self.calls) == 2 else 204)
        self.responses.append(result)
        return result


class SecretSetupTests(unittest.TestCase):
    def setUp(self):
        self.env = fake_environment()
        self.network = FakeNetwork()
        self.client_factory = lambda token: setup.GitHubSecretsClient(token, opener=self.network)

    def test_mapping_matches_actual_workflow_and_collector_config_without_crypto_dependency(self):
        root = Path(__file__).parents[1]
        workflow = (root / ".github" / "workflows" / "update-dashboard.yml").read_text(encoding="utf-8")
        workflow_pairs = re.findall(r"^\s+(OKX[A-Z_]+): \$\{\{ secrets\.(OKX[A-Z_]+) \}\}", workflow, re.MULTILINE)
        self.assertEqual({destination: source for source, destination in workflow_pairs}, setup.SECRET_ENV)
        config = json.loads((root / "config.example.json").read_text(encoding="utf-8"))
        self.assertEqual({source for bot in config["bots"] for source in bot["env"].values()},
                         set(setup.SECRET_ENV.values()))
        self.assertEqual(setup.SECRET_NAMES, ("OKX_A_API_KEY", "OKX_A_SECRET_KEY", "OKX_A_PASSPHRASE",
                                            "OKX_B_API_KEY", "OKX_B_SECRET_KEY", "OKX_B_PASSPHRASE",
                                            "DASHBOARD_STATE_KEY"))

    @unittest.skipUnless(public is not None, "Optional PyNaCl setup dependency")
    def test_apply_uses_exact_eight_requests_and_all_ciphertexts_decrypt(self):
        expected_mapping = {
            "OKX_A_API_KEY": "OKX_A_API_KEY", "OKX_A_SECRET_KEY": "OKX_A_SECRET_KEY",
            "OKX_A_PASSPHRASE": "OKX_A_PASSPHRASE", "OKX_B_API_KEY": "OKX_API_KEY",
            "OKX_B_SECRET_KEY": "OKX_SECRET_KEY", "OKX_B_PASSPHRASE": "OKX_PASSPHRASE",
        }
        expected_names = (*expected_mapping, "DASHBOARD_STATE_KEY")
        self.assertEqual(setup.SECRET_ENV, expected_mapping)
        state_key = bytes(range(32)).hex()  # Deliberately public TEST key.
        with patch.object(setup, "load_or_create_state_key", return_value=state_key):
            self.assertEqual(setup.setup(self.env, apply=True, client_factory=self.client_factory), "applied")
        requests = self.network.calls
        self.assertEqual([(req.method, req.full_url) for req, _ in requests],
                         [("GET", "https://api.github.com/repos/Fadinggo/race/actions/secrets/public-key")] +
                         [("PUT", "https://api.github.com/repos/Fadinggo/race/actions/secrets/" + name)
                          for name in expected_names])
        self.assertEqual({timeout for _, timeout in requests}, {20})
        unseal = public.SealedBox(self.network.private_key)
        for (req, _), name in zip(requests[1:], expected_names):
            payload = json.loads(req.data)
            self.assertEqual(set(payload), {"encrypted_value", "key_id"})
            self.assertEqual(payload["key_id"], "TEST_KEY_ID")
            decoded = unseal.decrypt(base64.b64decode(payload["encrypted_value"])).decode()
            self.assertEqual(decoded, state_key if name == "DASHBOARD_STATE_KEY" else self.env[expected_mapping[name]])
            self.assertNotIn(decoded.encode(), req.data)
            self.assertEqual(req.get_header("Authorization"), "Bearer " + self.env[setup.TOKEN_ENV])
            self.assertEqual(req.get_header("X-github-api-version"), setup.API_VERSION)
        self.assertTrue(all(response.read_calls == 0 for response in self.network.responses[1:]))

    def test_default_dry_run_has_no_network_no_files_and_prints_only_names(self):
        with patch.object(setup, "load_or_create_state_key") as state, patch.object(setup.request, "build_opener") as opener:
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(setup.main([], environment=self.env), 0)
            state.assert_not_called()
            opener.assert_not_called()
        self.assertEqual(stdout.getvalue().splitlines(), ["dry_run: Fadinggo/race", *setup.SECRET_NAMES])
        for value in self.env.values():
            self.assertNotIn(value, stdout.getvalue() + stderr.getvalue())

    def test_every_missing_or_blank_okx_env_causes_zero_network_or_state_calls(self):
        for name in setup.SECRET_ENV.values():
            for missing in (None, "", "   "):
                with self.subTest(name=name, missing=missing):
                    env = dict(self.env)
                    env[name] = missing
                    factory, state = Mock(), Mock()
                    with patch.object(setup, "load_or_create_state_key", state):
                        with self.assertRaisesRegex(setup.SetupError, "missing_okx_environment"):
                            setup.setup(env, apply=True, client_factory=factory)
                    factory.assert_not_called()
                    state.assert_not_called()

    def test_duplicate_accounts_and_wrong_token_are_rejected_before_network(self):
        for edit, code in (({"OKX_API_KEY": self.env["OKX_A_API_KEY"]}, "account_api_keys_must_differ"),
                           ({setup.TOKEN_ENV: "ghp_FAKE_CLASSIC_PAT"}, "fine_grained_setup_token_required")):
            factory = Mock()
            with self.assertRaisesRegex(setup.SetupError, code):
                setup.setup({**self.env, **edit}, apply=True, client_factory=factory)
            factory.assert_not_called()

    def test_allowlist_blocks_other_host_repo_secret_and_plain_http(self):
        client = self.client_factory(self.env[setup.TOKEN_ENV])
        urls = ("http://api.github.com/repos/Fadinggo/race/actions/secrets/public-key",
                "https://evil.invalid/", setup.PUBLIC_KEY_URL.replace("Fadinggo", "Other"),
                setup.API_BASE + "/UNAPPROVED_SECRET", setup.PUBLIC_KEY_URL + "?redirect=1")
        for url in urls:
            with self.assertRaisesRegex(setup.SetupError, "outside_allowlist"):
                client._request("GET", url)
        with self.assertRaisesRegex(setup.SetupError, "outside_allowlist"):
            client.put_secret("UNAPPROVED_SECRET", "TEST_CIPHERTEXT", "TEST_ID")
        self.assertEqual(self.network.calls, [])

    def test_redirect_handler_rejects_every_redirect_without_following(self):
        handler = setup.NoRedirects()
        for code in (301, 302, 303, 307, 308):
            with self.assertRaisesRegex(setup.SetupError, "github_redirect_refused"):
                handler.redirect_request(None, None, code, "secret-response", {}, "https://evil.invalid")
        opener = Mock()
        opener.open.return_value = FakeResponse("https://evil.invalid", 200, {})
        with self.assertRaisesRegex(setup.SetupError, "github_redirect_refused"):
            setup.GitHubSecretsClient("FAKE", opener=opener).public_key()
        self.assertEqual(opener.open.call_count, 1)

    @unittest.skipUnless(public is not None, "Optional PyNaCl setup dependency")
    def test_error_body_token_values_and_exception_details_never_reach_output(self):
        sensitive = "\n".join(self.env.values())
        body = io.BytesIO(sensitive.encode())
        body.read = Mock(side_effect=AssertionError("Error body must not be read"))
        failure = error.HTTPError(setup.PUBLIC_KEY_URL, 403, sensitive, {}, body)
        opener = Mock()
        opener.open.side_effect = failure
        factory = lambda token: setup.GitHubSecretsClient(token, opener=opener)
        actual_setup = setup.setup
        def configured_setup(environment, *, apply):
            return actual_setup(environment, apply=apply, client_factory=factory)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(setup, "setup", side_effect=configured_setup), \
                patch.object(setup, "load_or_create_state_key", return_value="00" * 32), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(setup.main(["--apply"], environment=self.env), 1)
        self.assertEqual(stderr.getvalue(), "Setup failed: github_http_error\n")
        self.assertEqual(stdout.getvalue(), "")
        body.read.assert_not_called()
        for value in self.env.values():
            self.assertNotIn(value, stdout.getvalue() + stderr.getvalue())

    def test_unexpected_exception_redaction(self):
        output = io.StringIO()
        with patch.object(setup, "setup", side_effect=RuntimeError(self.env[setup.TOKEN_ENV])), \
                contextlib.redirect_stderr(output):
            self.assertEqual(setup.main(["--apply"], environment=self.env), 1)
        self.assertEqual(output.getvalue(), "Setup failed: unexpected_setup_failure\n")

    def test_default_transport_disables_proxies_and_has_redirect_guard(self):
        with patch.object(setup.request, "build_opener") as build:
            setup.GitHubSecretsClient("FAKE")
        handlers = build.call_args.args
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[2], setup.NoRedirects)

    @unittest.skipUnless(public is not None, "Optional PyNaCl setup dependency")
    def test_partial_failure_retry_reuses_saved_key_and_finishes_same_seven_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "private" / "github-state.key"
            first_network = FakeNetwork()
            original_open = first_network.open
            def failing_open(req, *, timeout):
                if len(first_network.calls) == 3:
                    raise error.URLError("FAKE_SENSITIVE_TRANSPORT_DETAIL")
                return original_open(req, timeout=timeout)
            first_network.open = failing_open
            factory = lambda token: setup.GitHubSecretsClient(token, opener=first_network)
            # Only the guard is bypassed for disposable Windows TEST files.
            guard = contextlib.nullcontext() if os.name == "posix" else patch.object(setup, "require_posix")
            with guard:
                with self.assertRaisesRegex(setup.SetupError, "github_request_or_response_failed"):
                    setup.setup(self.env, apply=True, state_path=state_path, client_factory=factory)
                saved_bytes = state_path.read_bytes()
                with patch.object(setup.secrets, "token_bytes") as generate:
                    setup.setup(self.env, apply=True, state_path=state_path, client_factory=self.client_factory)
                generate.assert_not_called()
            self.assertEqual(state_path.read_bytes(), saved_bytes)
            self.assertEqual(len(first_network.calls), 3)
            self.assertEqual(len(self.network.calls), 8)
            state_request = self.network.calls[-1][0]
            encrypted = base64.b64decode(json.loads(state_request.data)["encrypted_value"])
            self.assertEqual(public.SealedBox(self.network.private_key).decrypt(encrypted), saved_bytes.strip())


class PrivateStateKeyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "private" / "github-state.key"
        # The production entry point fails closed on Windows. These tests use
        # fake keys to exercise persistence there; POSIX modes are tested below.
        if os.name != "posix":
            self.guard = patch.object(setup, "require_posix")
            self.guard.start()
            self.addCleanup(self.guard.stop)

    def test_independent_random_32_bytes_saved_once_and_reused_without_rotation(self):
        fake_bytes = bytes(range(32))
        with patch.object(setup.secrets, "token_bytes", return_value=fake_bytes) as generate:
            first = setup.load_or_create_state_key(self.path)
            before = self.path.read_bytes()
            second = setup.load_or_create_state_key(self.path)
        self.assertEqual(first, fake_bytes.hex())
        self.assertEqual(first, second)
        self.assertEqual(before, self.path.read_bytes())
        generate.assert_called_once_with(32)
        self.assertEqual(len(bytes.fromhex(first)), 32)

    def test_invalid_existing_key_is_not_replaced_and_does_not_generate(self):
        self.path.parent.mkdir(mode=0o700)
        self.path.write_bytes(b"INVALID_TEST_KEY")
        if os.name == "posix":
            self.path.chmod(0o600)
        with patch.object(setup.secrets, "token_bytes") as generate:
            with self.assertRaisesRegex(setup.SetupError, "existing_state_key_invalid"):
                setup.load_or_create_state_key(self.path)
        self.assertEqual(self.path.read_bytes(), b"INVALID_TEST_KEY")
        generate.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "POSIX file-mode semantics")
    def test_actual_posix_modes_and_existing_insecure_mode_fail_closed(self):
        setup.load_or_create_state_key(self.path)
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        old_bytes = self.path.read_bytes()
        self.path.chmod(0o644)
        with self.assertRaisesRegex(setup.SetupError, "permissions_or_owner_invalid"):
            setup.load_or_create_state_key(self.path)
        self.assertEqual(self.path.read_bytes(), old_bytes)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o644)

    def test_private_key_cannot_be_created_inside_git_checkout(self):
        (Path(self.temporary.name) / ".git").mkdir()
        with self.assertRaisesRegex(setup.SetupError, "inside_git_checkout"):
            setup.load_or_create_state_key(self.path)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
