import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("server_config", Path(__file__).with_name("server_config.py"))
server_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_config)


class ServerConfigTest(unittest.TestCase):
    def test_defaults_disable_graph_and_preserve_storage_models_and_auth(self):
        defaults = {
            "graph_store": {"provider": "neo4j"},
            "vector_store": {"provider": "pgvector"},
            "llm": {"config": {"api_key": "test-key", "model": "test-model"}},
            "embedder": {"provider": "openai"},
            "history_db_path": "/app/history/history.db",
        }
        with patch.dict(os.environ, {"MEM0_GRAPH_ENABLED": "false"}), patch.object(
            Path, "read_text", return_value=json.dumps("Preserve both speakers and source dates.")
        ):
            configured = server_config.configure(defaults)
        self.assertNotIn("graph_store", configured)
        self.assertIn("graph_store", defaults)
        for key in defaults.keys() - {"graph_store"}:
            self.assertEqual(configured[key], defaults[key])
        self.assertIn('"facts"', configured["custom_fact_extraction_prompt"])
        self.assertIn("both speakers", configured["custom_fact_extraction_prompt"])

    def test_graph_can_be_enabled_explicitly(self):
        with patch.dict(os.environ, {"MEM0_GRAPH_ENABLED": "true"}), patch.object(
            Path, "read_text", return_value='"instructions"'
        ):
            self.assertIn("graph_store", server_config.configure({"graph_store": {}}))

    def test_invalid_configuration_fails_at_startup(self):
        with patch.dict(os.environ, {"MEM0_GRAPH_ENABLED": "maybe"}):
            with self.assertRaises(ValueError):
                server_config.configure({})
        with patch.dict(os.environ, {"MEM0_GRAPH_ENABLED": "false"}), patch.object(
            Path, "read_text", return_value='{}'
        ):
            with self.assertRaises(ValueError):
                server_config.configure({})


if __name__ == "__main__":
    unittest.main()
