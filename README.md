# MemoryBench

A pluggable benchmarking framework for evaluating memory and context systems.

<img width="3584" height="2154" alt="original" src="https://github.com/user-attachments/assets/7fe49b7e-ed0b-4861-92a5-fa5d199cfc72" />


## Features

- 🔌 Interoperable: mix and match any provider with any benchmark
- 🧩 Bring your own benchmarks: plug in custom datasets and tasks
- ♻️ Checkpointed runs: resume from any pipeline stage (ingest → index → search → answer → evaluate)
- 🆚 Multi‑provider comparison: run the same benchmark across providers side‑by‑side
- 🧪 Judge‑agnostic: swap GPT‑4o, Claude, Gemini, etc. without code changes
- 📊 Structured reports: export run status, failures, and metrics for analysis
- 🖥️ Web UI: inspect runs, questions, and failures interactively, in real-time!


```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Benchmarks │    │  Providers  │    │   Judges    │
│  (LoCoMo,   │    │ (Supermem,  │    │  (GPT-4o,   │
│  LongMem..) │    │  Mem0, Zep) │    │  Claude..)  │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       └──────────────────┼──────────────────┘
                         ▼
             ┌───────────────────────┐
             │      MemoryBench      │
             └───────────┬───────────┘
                         ▼
   ┌────────┬─────────┬────────┬──────────┬────────┐
   │ Ingest │ Indexing│ Search │  Answer  │Evaluate│
   └────────┴─────────┴────────┴──────────┴────────┘
```

## Quick Start

```bash
bun install
cp .env.example .env.local  # Add your API keys
bun run src/index.ts run -p supermemory -b locomo
```

## Configuration

```bash
# Providers (at least one)
SUPERMEMORY_API_KEY=
MEM0_API_KEY=
ZEP_API_KEY=

# Judges (at least one)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

## Commands

| Command | Description |
|---------|-------------|
| `run` | Full pipeline: ingest → index → search → answer → evaluate → report |
| `compare` | Run benchmark across multiple providers simultaneously |
| `ingest` | Ingest benchmark data into provider |
| `search` | Run search phase only |
| `test` | Test single question |
| `status` | Check run progress |
| `list-questions` | Browse benchmark questions |
| `show-failures` | Debug failed questions |
| `serve` | Start web UI |
| `help` | Show help (`help providers`, `help models`, `help benchmarks`) |

### Logging

Add `-v` for debug logs or `-vv` for trace logs. Repeated `-v` or `--verbose`
flags also work, before or after the command. Counts above two use trace.
The default level is info.

```bash
bun run src/index.ts serve -v
bun run src/index.ts run -p atlas-agent-engine -b locomo -j gpt-5-mini -vv
```

For UI-started runs, set verbosity when starting `serve`. Restart the server to
change it. Debug logs show ingestion session counts, written and reused receipts, batches, active indexing questions, elapsed waits,
and Atlas polling summaries. Trace adds individual session and episode readiness
checks and ingestion operation durations without logging transcript content or credentials.
During ingestion, a 10-second heartbeat identifies the active session and any
slow remote write or local manifest operation. Trace logs separate manifest reads,
pending-write saves, remote writes, and receipt saves. Container tags identify the
question and run when several runs are active. Verbose progress uses
separate lines so diagnostics do not overwrite the progress bar.

Atlas extraction readiness waits at least 180 seconds after a session's last
write, then requires searchable episodes to remain unchanged for 60 seconds.
Debug polls distinguish that initial wait from missing episodes, unsearchable
episodes, and the stability wait. These checks infer readiness; they are not a
server extraction-complete signal.

## Options

```
-p, --provider         Memory provider (supermemory, mem0, zep)
-b, --benchmark        Benchmark (locomo, longmemeval, convomem)
-j, --judge            Judge model (gpt-4o, sonnet-4, gemini-2.5-flash, etc.)
-r, --run-id           Run identifier (auto-generated if omitted)
-m, --answering-model  Model for answer generation (default: gpt-4o)
-l, --limit            Limit number of questions
-q, --question-id      Specific question (for test command)
--force                Clear checkpoint and restart
```

## Examples

```bash
# Full run
bun run src/index.ts run -p mem0 -b locomo

# With custom run ID
bun run src/index.ts run -p mem0 -b locomo -r my-test

# Resume existing run
bun run src/index.ts run -r my-test

# Limited questions
bun run src/index.ts run -p supermemory -b locomo -l 10

# Different models
bun run src/index.ts run -p zep -b longmemeval -j sonnet-4 -m gemini-2.5-flash

# Compare multiple providers
bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -s 5

# Test single question
bun run src/index.ts test -r my-test -q question_42

# Debug
bun run src/index.ts status -r my-test
bun run src/index.ts show-failures -r my-test
```

## Pipeline

```
1. INGEST    Load benchmark sessions → Push to provider
2. INDEX     Wait for provider indexing
3. SEARCH    Query provider → Retrieve context
4. ANSWER    Build prompt → Generate answer via LLM
5. EVALUATE  Compare to ground truth → Score via judge
6. REPORT    Aggregate scores → Output accuracy + latency
```

Each phase checkpoints independently. Failed runs resume from last successful point.

## MemScore

MemScore is a composite metric that captures three dimensions of provider performance in a single line:

```
accuracy% / latencyMs / contextTokens
```

| Component | What it measures |
|-----------|-----------------|
| **Quality** | Answer accuracy — `(correct / total) * 100` from judge evaluations |
| **Latency** | Average search response time in milliseconds |
| **Tokens** | Average context tokens sent to the answering model (counted client-side) |

After a run completes, MemScore appears in the CLI summary:

```
Summary:
  Total Questions: 50
  Correct: 43
  Accuracy: 86.00%
  MemScore: 86% / 145ms / 1823tok
```

MemScore is intentionally a triple, not a single number — collapsing quality, latency, and cost into one score hides important tradeoffs. Use it to compare providers side-by-side on the same benchmark:

```bash
bun run src/index.ts compare -p supermemory,mem0,zep -b locomo -j gpt-4o
```

The `report.json` includes both a display string and structured `memscoreComponents` for programmatic use.

> **[Full MemScore documentation →](https://supermemory.ai/docs/memorybench/memscore)**

## Checkpointing

Runs persist to `data/runs/{runId}/`:
- `checkpoint.json` - Run state and progress
- `results/` - Search results per question
- `report.json` - Final report

Re-running same ID resumes. Use `--force` to restart.

## Extending

| Component | Guide |
|-----------|-------|
| Add Provider | [src/providers/README.md](src/providers/README.md) |
| Add Benchmark | [src/benchmarks/README.md](src/benchmarks/README.md) |
| Add Judge | [src/judges/README.md](src/judges/README.md) |
| Project Structure | [src/README.md](src/README.md) |

## License

MIT

### Source input parity

LoCoMo's two participants are both human speakers. Both use the `user` transport
role, with their actual names retained in source headers. Mem0 and Atlas receive
the same message content with speaker, source date, session ID, and original role.
Atlas direct may split long messages into chunks and repeats those headers.

Use new run IDs and ingest again when comparing runs created before this input
format change. Resuming an old checkpoint reuses previously ingested data and
does not retrofit speaker attribution or source headers.

### Shared answering policy

All providers use the same answering instructions, an 8,000-token evidence budget,
a 1,000-token output limit, and temperature 0 for models that support it. Select
the same answering model for compared runs; the `compare` command shares that
selection across providers. Provider-specific answer prompts are no longer used.

Evidence stays in retrieval order, using provider JSON with embedding vectors
removed. If the budget is exceeded, the next record is included as a marked
prefix excerpt and later records are excluded. Source content, dates, and speaker
attribution remain available to the common prompt. Context token counts use the
selected model's tokenizer, with the existing approximation for Google models.

Each answer checkpoint records `answerPolicy`, including version `shared-v1`,
model, generation settings, evidence budget, and included/retrieved result counts.
Old answers lack this marker and must be regenerated for a shared-policy
comparison. The input-parity change above also requires fresh ingestion under new
run IDs; regenerating answers alone cannot repair old ingested data.
