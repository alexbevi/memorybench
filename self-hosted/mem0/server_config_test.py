import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("server_config", Path(__file__).with_name("server_config.py"))
server_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_config)


class ServerConfigTest(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {
            "MEM0_EXTRACTION_MODEL": "", "MEM0_GRAPH_ENABLED": "false",
            "MEM0_MODEL_API_KEY_HEADER": "",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def test_extraction_model_alias_is_optional_and_leaves_embeddings_unchanged(self):
        defaults = {"llm": {"config": {"model": "pinned"}}, "embedder": {"model": "embedding"}}
        with patch.dict(os.environ, {"MEM0_EXTRACTION_MODEL": "alias", "MEM0_GRAPH_ENABLED": "false"}), patch.object(
            Path, "read_text", return_value='"instructions"'
        ):
            configured = server_config.configure(defaults)
        self.assertEqual(configured["llm"]["config"]["model"], "alias")
        self.assertEqual(configured["embedder"], defaults["embedder"])
        self.assertEqual(defaults["llm"]["config"]["model"], "pinned")

    def test_gateway_header_reaches_vector_and_graph_model_clients(self):
        calls = []

        class Client:
            def with_options(self, **kwargs):
                calls.append(kwargs)
                return self

        component = lambda: SimpleNamespace(client=Client())
        memory = SimpleNamespace(
            llm=component(), embedding_model=component(), enable_graph=True,
            graph=SimpleNamespace(llm=component(), embedding_model=component()),
        )
        with patch.dict(os.environ, {"MEM0_MODEL_API_KEY_HEADER": "api-key", "OPENAI_API_KEY": "test-key"}):
            self.assertIs(server_config.configure_gateway(memory), memory)
        self.assertEqual(calls, [{"default_headers": {"api-key": "test-key"}}] * 4)

    def test_gateway_header_is_opt_in_and_validated(self):
        memory = object()
        with patch.dict(os.environ, {"MEM0_MODEL_API_KEY_HEADER": ""}):
            self.assertIs(server_config.configure_gateway(memory), memory)
        with patch.dict(os.environ, {"MEM0_MODEL_API_KEY_HEADER": "bad\nheader"}):
            with self.assertRaises(ValueError):
                server_config.configure_gateway(memory)
        with patch.dict(os.environ, {"MEM0_MODEL_API_KEY_HEADER": "api-key", "OPENAI_API_KEY": ""}):
            with self.assertRaises(ValueError):
                server_config.configure_gateway(memory)

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
