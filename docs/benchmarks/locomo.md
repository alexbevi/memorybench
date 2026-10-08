# LoCoMo and the Atlas Memory Service comparison

LoCoMo tests whether a system can use details scattered through a long conversation history. In this suite, it is particularly useful for explaining speaker attribution, dates, combining evidence, and knowing when to abstain. The saved October 7, 2026 runs expose useful failure cases, but they are ten-question diagnostic samples made before the current comparison policies. They do not establish a current provider ranking.

## What LoCoMo contains

The released dataset contains ten conversations between named personas. LLM agents generated the conversations, and humans reviewed and edited them. The original work evaluates question answering, event summarization, and multimodal dialogue generation. This repository uses the question-answering task and conversation message text. It does not run the other tasks or ingest image content through the LoCoMo adapter. See the [LoCoMo project](https://snap-research.github.io/locomo/) and [official dataset repository](https://github.com/snap-research/locomo).

The local `locomo10.json` has 1,986 questions. The following counts come from that file, and the mapping comes from the [current adapter](../../src/benchmarks/locomo/index.ts).

| Dataset category | Suite type | Questions | Ability being tested |
| --- | --- | ---: | --- |
| 1 | `multi-hop` | 282 | Combine evidence to answer a question |
| 2 | `temporal` | 321 | Interpret dates, ordering, and relative time |
| 3 | `world-knowledge` | 96 | Connect conversation evidence with commonsense or world knowledge |
| 4 | `single-hop` | 841 | Recover a fact from the conversation |
| 5 | `adversarial` | 446 | Avoid answering a question unsupported by the conversation |

Category labels are dataset annotations, not guarantees about how many reasoning steps every individual item needs. The current shared answer prompt asks for evidence-grounded answers even on world-knowledge questions. That policy affects how to interpret this category.

The full dataset weights categories unevenly. A sample with two questions per category gives each category 20% of its score, so its aggregate accuracy has a different meaning from full-dataset accuracy.

## How a question runs here

1. The adapter selects a question and attaches all sessions from its conversation as the available history. It retains the reference answer and evidence IDs for evaluation metadata.
2. Ingestion writes that history into a namespace specific to the question and run. Questions from the same conversation therefore repeat ingestion into separate namespaces.
3. The provider forms and indexes its memories. Atlas extraction records turns; Atlas direct saves transcript chunks; mem0 extracts memories from the supplied messages.
4. Search sends the question and requests ten results. It does not receive the reference answer or gold evidence IDs.
5. The common answer policy fits retrieved evidence into its budget and asks the selected model to answer or say it does not know.
6. A judge compares the answer with the reference. A separate relevance assessment inspects retrieved records.

Both LoCoMo personas currently use the `user` transport role, with their distinct names preserved. Atlas and mem0 receive source headers containing session, source date, speaker, and role. This is an adapter convention intended to retain both speakers' facts. Atlas direct repeats headers when splitting long messages. See [source formatting](../../src/utils/source-message.ts) and [ingestion](../../src/orchestrator/phases/ingest.ts).

For adversarial items, the adapter sets the expected answer to "Not mentioned in the conversation" rather than using the dataset's distractor answer. The default judge accepts abstention. For temporal items, the default judge allows certain off-by-one duration errors. Our primary score is binary LLM-judged answer accuracy; the original project's displayed QA results use answer F1. These are different scoring protocols, so published LoCoMo percentages cannot be compared directly with ours. See the [judge instructions](../../src/prompts/defaults.ts) and [original evaluation](https://snap-research.github.io/locomo/).

## A question that explains the benchmark

Consider `conv-26-q0`, which asks when Caroline attended the LGBTQ support group. The supporting turn says she went "yesterday" in a session dated May 8, 2023. The reference answer is May 7, 2023.

The system needs the event, the correct speaker, the source date, and the relationship between that date and "yesterday". Retrieving a memory about the support group is insufficient if the date was lost or rewritten.

| Historical run | Evidence and answer observed | What this example demonstrates |
| --- | --- | --- |
| Atlas direct, `atlas-agent-engine-direct-locomo-20261007-wtdq` | Retrieved the source date and original relative-date wording; answered May 7, 2023 | Retained transcript context supported the date calculation |
| Atlas extraction, `atlas-agent-engine-locomo-20261007-bl2g` | Retrieved support-group memories without the needed event date; answered that no date was specified | Relevant retrieved facts can omit essential temporal context |
| mem0, `mem0-locomo-20261007-pgvh` | Retrieved a memory stating October 6, 2026, although its session metadata carried a 2023 source date; answered October 6, 2026 | The retrieved memory already contained a wrong event date |
| Atlas extraction, `compare-20261007-184407-atlas-agent-engine` | Retrieved an episode retaining "yesterday" with a 2026 service timestamp; answered October 6, 2026 | The answer used a service record date to resolve conversational time |

These observations identify different failure stages. They do not establish why the remote extractor produced a particular memory. The old runs also used different prompts and, in some cases, different models. The current shared answer policy explicitly distinguishes source dates from service timestamps, and the current input formatting differs from these historical inputs.

The historical Atlas extraction and mem0 runs both received a retrieval hit on this question despite answering incorrectly. That is why relevance and answer accuracy need separate explanations.

## What the saved runs show

All five local LoCoMo reports below evaluate the same ten question IDs from `conv-26`, with two questions in each correctly mapped category. Each answer changes aggregate accuracy by ten percentage points. The table records historical artifacts, not results from the current policy.

| Run ID | Correct | Answer model | Judge | Mean search ms | Mean context tokens |
| --- | ---: | --- | --- | ---: | ---: |
| `atlas-agent-engine-direct-locomo-20261007-wtdq` | 7/10 | gpt-4o | gpt-4o | 245 | 993 |
| `atlas-agent-engine-locomo-20261007-bl2g` | 5/10 | gpt-5 | gpt-5 | 365 | 711 |
| `mem0-locomo-20261007-pgvh` | 5/10 | gpt-5 | gpt-5 | 550 | 586 |
| `compare-20261007-184407-atlas-agent-engine` | 6/10 | gpt-5 | gpt-5-mini | 299 | 708 |
| `compare-20261007-184407-mem0` | 5/10 | gpt-5 | gpt-5-mini | 498 | 593 |

The paired comparison records one more correct Atlas answer than mem0, along with lower mean Atlas search latency and more context tokens. This is an observation about that ten-question run. The sample size, single-conversation coverage, and historical policies prevent a general claim that Atlas outperforms mem0. The direct-mode score also uses different answer and judge models from the extraction runs.

Every saved LoCoMo answer checkpoint lacks the current `answerPolicy` marker. Saved question types are also stale: for example, `conv-26-q0` is labeled `multi-hop` in reports but is category 2, `temporal`, in the dataset. Old category breakdowns should not be reused. Because categories select judge instructions, changing display labels alone would not repair grading.

Source-input parity also requires fresh ingestion. Old direct results still label Melanie as `assistant`. Resuming old checkpoints preserves old remote memories; regenerating answers alone cannot establish current input parity.

## The next comparable experiment

Start with fresh run IDs and the current adapter, then verify all phases complete and every answer records `shared-v1`. This command creates a small paired diagnostic comparison with a shared selection and models:

```sh
bun run src/index.ts compare \
  -p atlas-agent-engine,atlas-agent-engine-direct,mem0 \
  -b locomo -s 2 -m gpt-5 -j gpt-5-mini \
  --compare-id locomo-shared-v1-diagnostic-01
```

This command is an example for a new run, not an experiment performed for this document. Consecutive sampling remains a diagnostic convenience. Expand to multiple conversations or the full dataset before making broader claims, preserve the selected IDs, and report category counts and paired disagreements. Record extraction settings and deployment versions alongside results. See the [shared comparison requirements](README.md#evidence-needed-for-a-provider-claim).

Audit speaker and date preservation first. For failures, inspect the source turn, stored memory if accessible, retrieved record, included evidence after truncation, generated answer, and judge explanation. Classify missing storage, missed retrieval, lost provenance, answer mistakes, and grading disagreements separately. Inspect actual evidence before assigning a cause.

## What to say in a presentation

"LoCoMo asks whether a memory system can recover details from repeated conversations between two people. A simple question like when someone attended an event can require preserving the speaker, a session date, and a phrase like 'yesterday.' We test Atlas in extraction and direct-transcript modes alongside mem0. Our initial runs show why relevant memories can still produce wrong answers, especially when dates are lost or rewritten. A fresh comparison under the shared policy is needed before we claim a provider advantage."

LoCoMo QA does not establish production scalability, privacy, deletion behavior, total operating cost, or general agent quality. The current tests ingest the available history before answering; they do not measure a live assistant learning and answering throughout a user's life.

## Evidence references

- Local dataset: `data/benchmarks/locomo/locomo10.json`, SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
- Historical results: `data/runs/<run ID>/report.json`, `checkpoint.json`, and `results/conv-26-q0.json` for the runs above. These are local artifacts and may not be present in another checkout.
- Paired selection: `data/compare/compare-20261007-184407/manifest.json`.
- Implementation snapshot inspected October 8, 2026: HEAD `0496829289077a76fea123bd6aa9d5fea1ceafb2`, with existing local changes to search and Supermemory. This identifies the inspected working tree, not the code version of the historical runs.
- [Category regression tests](../../src/benchmarks/locomo/categories.test.ts), [mem0 input tests](../../src/providers/mem0/input-parity.test.ts), and [answer policy tests](../../src/prompts/answer.test.ts) document the current contracts. Offline tests do not verify remote extraction quality.
