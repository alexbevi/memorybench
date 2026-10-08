"""Persistent benchmark settings applied before the pinned server creates Memory."""

import copy
import json
import os
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
