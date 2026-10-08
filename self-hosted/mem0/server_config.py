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

    instructions = json.loads(Path("/app/extraction-instructions.json").read_text())
    if not isinstance(instructions, str) or not instructions.strip():
        raise ValueError("Expected nonempty extraction instructions")
    config["custom_fact_extraction_prompt"] = instructions + (
        '\n\nReturn only a JSON object with a "facts" array of memory strings. '
        'Use {"facts": []} when no facts should be stored.'
    )
    return config


def configure_gateway(memory):
    """Add the existing model credential under an explicitly configured header."""
    header = os.environ.get("MEM0_MODEL_API_KEY_HEADER", "")
    if not header:
        return memory
    if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", header):
        raise ValueError("MEM0_MODEL_API_KEY_HEADER must be an HTTP header name")
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise ValueError("OPENAI_API_KEY is required for the model gateway header")
    components = [memory.llm, memory.embedding_model]
    if memory.enable_graph:
        components.extend([memory.graph.llm, memory.graph.embedding_model])
    for component in components:
        component.client = component.client.with_options(default_headers={header: key})
    return memory


def create_memory(defaults):
    from mem0 import Memory

    return configure_gateway(Memory.from_config(configure(defaults)))
