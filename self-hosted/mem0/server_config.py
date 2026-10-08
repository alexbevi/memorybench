"""Persistent benchmark settings applied before the pinned server creates Memory."""

import copy
import json
import os
import re
from pathlib import Path


def configure(defaults):
    config = copy.deepcopy(defaults)
    graph = os.environ.get("MEM0_GRAPH_ENABLED", "false").lower()
    if graph not in {"true", "false"}:
        raise ValueError("MEM0_GRAPH_ENABLED must be true or false")
    if graph == "false":
        config.pop("graph_store", None)
    model = os.environ.get("MEM0_EXTRACTION_MODEL", "").strip()
    if model:
        config["llm"]["config"]["model"] = model
    embedding_model = os.environ.get("MEM0_EMBEDDING_MODEL", "").strip()
    embedding_url = os.environ.get("MEM0_EMBEDDING_BASE_URL", "").strip()
    embedding_key = os.environ.get("MEM0_EMBEDDING_API_KEY", "")
    embedding_format = os.environ.get("MEM0_EMBEDDING_API_FORMAT", "openai") or "openai"
    if embedding_format not in {"openai", "voyage"}:
        raise ValueError("MEM0_EMBEDDING_API_FORMAT must be openai or voyage")
    if embedding_format == "voyage" and not embedding_model:
        raise ValueError("Set MEM0_EMBEDDING_MODEL for the voyage API format")
    dimensions = os.environ.get("MEM0_EMBEDDING_DIMENSIONS", "").strip()
    if embedding_model:
        config["embedder"]["config"]["model"] = embedding_model
        if not dimensions:
            raise ValueError("Set MEM0_EMBEDDING_DIMENSIONS when overriding the embedding model")
    if embedding_url:
        config["embedder"]["config"]["openai_base_url"] = embedding_url
    if embedding_key:
        config["embedder"]["config"]["api_key"] = embedding_key
    if dimensions:
        if not dimensions.isascii() or not dimensions.isdigit() or int(dimensions) <= 0:
            raise ValueError("MEM0_EMBEDDING_DIMENSIONS must be a positive integer")
        config["vector_store"]["config"]["embedding_model_dims"] = int(dimensions)
        # This is the expected vector size, not a request to resize embeddings.
        # OpenAI's `dimensions` request field is not portable to Voyage gateways.
    if embedding_model or dimensions:
        collection = config["vector_store"]["config"].get("collection_name", "memories")
        if collection in {"memories", "mem0"}:
            raise ValueError("Use a dedicated POSTGRES_COLLECTION_NAME for custom embeddings")

    instructions = json.loads(Path("/app/extraction-instructions.json").read_text())
    if not isinstance(instructions, str) or not instructions.strip():
        raise ValueError("Expected nonempty extraction instructions")
    config["custom_fact_extraction_prompt"] = instructions + (
        '\n\nReturn only a JSON object with a "facts" array of memory strings. '
        'Use {"facts": []} when no facts should be stored.'
    )
    return config


def configure_gateway(memory):
    """Configure extraction and embedding credentials independently."""
    header = os.environ.get("MEM0_MODEL_API_KEY_HEADER", "")
    embedding_header = os.environ.get("MEM0_EMBEDDING_API_KEY_HEADER", "")
    # A separate endpoint must not inherit the extraction gateway's custom header.
    if not embedding_header and not os.environ.get("MEM0_EMBEDDING_BASE_URL", "").strip():
        embedding_header = header
    if not header and not embedding_header:
        return memory
    llm_key = os.environ.get("OPENAI_API_KEY", "")
    embedding_key = os.environ.get("MEM0_EMBEDDING_API_KEY", "") or llm_key
    components = [(memory.llm, header, llm_key), (memory.embedding_model, embedding_header, embedding_key)]
    if memory.enable_graph:
        components.extend([(memory.graph.llm, header, llm_key), (memory.graph.embedding_model, embedding_header, embedding_key)])
    for component, client_header, key in components:
        if not client_header:
            continue
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", client_header):
            raise ValueError("Gateway API key header must be an HTTP header name")
        if not key:
            raise ValueError("A model API key is required for the gateway header")
        component.client = component.client.with_options(default_headers={client_header: key})
    return memory


def create_memory(defaults):
    from mem0 import Memory

    config = configure(defaults)
    memory = configure_gateway(Memory.from_config(config))
    dimensions = config["vector_store"]["config"].get("embedding_model_dims", 1536)
    if os.environ.get("MEM0_EMBEDDING_API_FORMAT") == "voyage":
        use_voyage_api(memory.embedding_model, dimensions)
        if memory.enable_graph:
            use_voyage_api(memory.graph.embedding_model, dimensions)
    check_embedding_dimensions(memory.embedding_model, dimensions)
    if memory.enable_graph:
        check_embedding_dimensions(memory.graph.embedding_model, dimensions)
    return memory


def use_voyage_api(embedder, dimensions):
    """Use the native Voyage body with the configured HTTP client's auth/retries."""
    def embed(text, memory_action=None):
        response = embedder.client.post("/embeddings", body={
            "model": embedder.config.model,
            "input": [text.replace("\n", " ")],
            "input_type": "query" if memory_action == "search" else "document",
            "output_dimension": dimensions,
        }, cast_to=dict)
        try:
            vector = response["data"][0]["embedding"]
            if not isinstance(vector, list) or not all(isinstance(x, (int, float)) for x in vector):
                raise ValueError()
            return vector
        except (KeyError, IndexError, TypeError, ValueError):
            raise ValueError("Voyage returned an invalid embedding response") from None

    embedder.embed = embed


def check_embedding_dimensions(embedder, dimensions):
    original = embedder.embed

    def checked_embed(*args, **kwargs):
        vector = original(*args, **kwargs)
        if len(vector) != dimensions:
            raise ValueError(
                f"Embedding dimension mismatch: expected {dimensions}, received {len(vector)}. "
                "Check the embedding deployment and use a matching dedicated collection."
            )
        return vector

    embedder.embed = checked_embed
