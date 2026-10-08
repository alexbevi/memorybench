"""Offline regression tests for Compose's shell-over-dotenv precedence."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


class ComposeTest(unittest.TestCase):
    def test_stale_shell_settings_are_removed_from_any_working_directory(self):
        source = Path(__file__).parent
        settings = set(re.findall(r"(?<!\$)\$\{([A-Z_][A-Z0-9_]*)", (source / "docker-compose.yml").read_text()))
        with tempfile.TemporaryDirectory(prefix="mem0 compose ") as directory:
            root = Path(directory)
            service = root / "service with spaces"
            service.mkdir()
            shutil.copy(source / "compose.sh", service / "compose.sh")
            (service / ".env").write_text("OPENAI_BASE_URL=https://configured.example/v1\n")
            binary = root / "docker"
            binary.write_text(
                f"#!{sys.executable}\nimport json, os, sys\n"
                f"print(json.dumps({{'args':sys.argv[1:], 'settings':{{k:os.environ.get(k) for k in {sorted(settings)!r}}}}}))\n"
            )
            binary.chmod(0o755)
            environment = {**os.environ, **{k: "stale-shell-value" for k in settings},
                           "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            for cwd in [root, service]:
                response = json.loads(subprocess.check_output(
                    [str(service / "compose.sh"), "up", "-d"], cwd=cwd, env=environment, text=True,
                ))
                self.assertTrue(all(v is None for v in response["settings"].values()))
                self.assertEqual(response["args"], [
                    "compose", "--env-file", str(service / ".env"),
                    "-f", str(service / "docker-compose.yml"), "up", "-d",
                ])

    def test_missing_service_environment_fails_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "compose.sh"
            shutil.copy(Path(__file__).with_name("compose.sh"), script)
            result = subprocess.run([str(script), "up"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("grove.env.example", result.stderr)


if __name__ == "__main__":
    unittest.main()
