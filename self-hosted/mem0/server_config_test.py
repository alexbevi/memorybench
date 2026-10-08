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
            "MEM0_EMBEDDING_MODEL": "", "MEM0_EMBEDDING_BASE_URL": "",
            "MEM0_EMBEDDING_DIMENSIONS": "",
            "MEM0_EMBEDDING_API_KEY": "", "MEM0_EMBEDDING_API_KEY_HEADER": "",
            "MEM0_EMBEDDING_API_FORMAT": "openai",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def test_voyage_configuration_keeps_extraction_and_embedding_request_shape(self):
        defaults = {
            "llm": {"config": {"model": "extractor"}},
            "embedder": {"provider": "openai", "config": {"model": "text-embedding-3-small"}},
            "vector_store": {"config": {"collection_name": "memories_voyage_4_lite_1024"}},
        }
        with patch.dict(os.environ, {
            "MEM0_EMBEDDING_MODEL": "voyage-4-lite", "MEM0_EMBEDDING_DIMENSIONS": "1024",
            "MEM0_EMBEDDING_BASE_URL": "https://gateway.example/voyage/v1",
        }), patch.object(Path, "read_text", return_value='"instructions"'):
            configured = server_config.configure(defaults)
        self.assertEqual(configured["llm"], defaults["llm"])
        self.assertEqual(configured["embedder"]["config"], {
            "model": "voyage-4-lite", "openai_base_url": "https://gateway.example/voyage/v1",
        })
        self.assertEqual(configured["vector_store"]["config"]["embedding_model_dims"], 1024)
        self.assertNotIn("embedding_dims", configured["embedder"]["config"])

    def test_native_voyage_body_uses_document_and_query_inputs_without_openai_encoding(self):
        calls = []

        class Client:
            def post(self, path, **kwargs):
                calls.append((path, kwargs))
                return {"data": [{"embedding": [0.1, 0.2]}]}

        embedder = SimpleNamespace(client=Client(), config=SimpleNamespace(model="voyage-4-lite"))
        server_config.use_voyage_api(embedder, 2)
        server_config.check_embedding_dimensions(embedder, 2)
        self.assertEqual(embedder.embed("a\nb", "add"), [0.1, 0.2])
        embedder.embed("question", "search")
        self.assertEqual(calls[0][1]["body"], {
            "model": "voyage-4-lite", "input": ["a b"],
            "input_type": "document", "output_dimension": 2,
        })
        self.assertEqual(calls[1][1]["body"]["input_type"], "query")
        self.assertEqual(calls[0][0], "/embeddings")

    def test_voyage_rejects_malformed_vectors_and_invalid_api_format(self):
        for response in [{}, {"data": []}, {"data": [{"embedding": "base64"}]}]:
            client = SimpleNamespace(post=lambda *args, **kwargs: response)
            embedder = SimpleNamespace(client=client, config=SimpleNamespace(model="voyage-4-lite"))
            server_config.use_voyage_api(embedder, 1024)
            with self.assertRaisesRegex(ValueError, "invalid embedding"):
                embedder.embed("text")
        with patch.dict(os.environ, {"MEM0_EMBEDDING_API_FORMAT": "invalid"}):
            with self.assertRaisesRegex(ValueError, "API_FORMAT"):
                server_config.configure({})

    def test_custom_embeddings_require_dimensions_and_a_dedicated_collection(self):
        defaults = {"embedder": {"config": {}}, "vector_store": {"config": {"collection_name": "memories"}}}
        with patch.dict(os.environ, {"MEM0_EMBEDDING_MODEL": "voyage-4-lite"}):
            with self.assertRaisesRegex(ValueError, "DIMENSIONS"):
                server_config.configure(defaults)
        with patch.dict(os.environ, {"MEM0_EMBEDDING_DIMENSIONS": "1024"}):
            with self.assertRaisesRegex(ValueError, "dedicated"):
                server_config.configure(defaults)
        for invalid in ["0", "-1", "1.5", "abc"]:
            with patch.dict(os.environ, {"MEM0_EMBEDDING_DIMENSIONS": invalid}):
                with self.assertRaisesRegex(ValueError, "positive integer"):
                    server_config.configure(defaults)

    def test_embedding_dimension_check_preserves_calls_and_rejects_wrong_vectors(self):
        calls = []

        def embed(text, memory_action=None):
            calls.append((text, memory_action))
            return [0.1, 0.2]

        embedder = SimpleNamespace(embed=embed)
        server_config.check_embedding_dimensions(embedder, 2)
        self.assertEqual(embedder.embed("sample", memory_action="search"), [0.1, 0.2])
        self.assertEqual(calls, [("sample", "search")])
        server_config.check_embedding_dimensions(embedder, 3)
        with self.assertRaisesRegex(ValueError, "expected 3, received 2"):
            embedder.embed("sample")

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
        memory = SimpleNamespace(llm=None, embedding_model=None, enable_graph=False)
        with patch.dict(os.environ, {"MEM0_MODEL_API_KEY_HEADER": ""}):
            self.assertIs(server_config.configure_gateway(memory), memory)
        with patch.dict(os.environ, {"MEM0_MODEL_API_KEY_HEADER": "bad\nheader"}):
            with self.assertRaises(ValueError):
                server_config.configure_gateway(memory)

    def test_separate_embedding_gateway_does_not_receive_extraction_credentials(self):
        calls = []

        class Client:
            def __init__(self, name):
                self.name = name

            def with_options(self, **kwargs):
                calls.append((self.name, kwargs))
                return self

        memory = SimpleNamespace(
            llm=SimpleNamespace(client=Client("extraction")),
            embedding_model=SimpleNamespace(client=Client("embedding")), enable_graph=False,
        )
        with patch.dict(os.environ, {
            "MEM0_MODEL_API_KEY_HEADER": "api-key", "OPENAI_API_KEY": "extraction-key",
            "MEM0_EMBEDDING_BASE_URL": "https://example.com/voyage/v1",
            "MEM0_EMBEDDING_API_KEY_HEADER": "x-api-key", "MEM0_EMBEDDING_API_KEY": "embedding-key",
        }):
            server_config.configure_gateway(memory)
        self.assertEqual(calls, [
            ("extraction", {"default_headers": {"api-key": "extraction-key"}}),
            ("embedding", {"default_headers": {"x-api-key": "embedding-key"}}),
        ])
        calls.clear()
        with patch.dict(os.environ, {
            "MEM0_MODEL_API_KEY_HEADER": "api-key", "OPENAI_API_KEY": "extraction-key",
            "MEM0_EMBEDDING_BASE_URL": "https://example.com/voyage/v1",
        }):
            server_config.configure_gateway(memory)
        self.assertEqual(calls, [("extraction", {"default_headers": {"api-key": "extraction-key"}})])
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
