# Benchmark chapter template

Copy this structure for LongMemEval or another benchmark. Replace the instructions with verified findings and link the chapter from the [comparison guide](README.md).

## What this benchmark adds

State the memory ability it tests, why that matters to an assistant, and the strongest conclusion supported by the current evidence. Give a brief spoken explanation that a reader can reuse.

## Dataset and task

Identify the primary source, exact variant and checksum, conversation construction, roles, session scale, question counts, category definitions, and answerable versus unanswerable items. Separate the original benchmark's tasks from those implemented here.

## How it runs in this suite

Describe history selection, transformations, dates and speaker attribution, provider input, namespaces, retrieval limits, evidence budget, answering policy, judge rules, and departures from the original evaluation. Link implementation files. Explain what the answer model can see and what remains evaluation-only.

## A worked question

Show one source fact, question, reference answer, retrieved evidence, generated answer, and judgment. Use matched question IDs across providers. Distinguish observed failures from hypotheses about their causes.

## Results and comparability

Record the run IDs and selection manifest. Report intended and evaluated counts, conversation coverage, category accuracy with denominators, overall accuracy, search latency, and context tokens. Identify missing policies, stale labels, different models, or incomplete runs next to the affected results. Separate historical diagnostics from comparable current runs.

| Provider and mode | Correct / evaluated | Evaluated / intended | Search ms | Context tokens | Policy and models |
| --- | --- | --- | --- | --- | --- |
| Atlas extraction | To measure | To measure | To measure | To measure | To record |
| Atlas direct | To measure | To measure | To measure | To measure | To record |
| mem0 | To measure | To measure | To measure | To measure | To record |

Add other tested providers as rows. Leave unmeasured values explicit. Do not infer scores from another benchmark.

## Interpretation and next experiment

State what the evidence supports, what it leaves unresolved, and the next experiment needed to distinguish possible explanations. Include paired question disagreements and repeatability when available. Link the common comparison requirements rather than repeating them.

## Presentation wording and evidence

Write a short spoken explanation with the finding and its scope. List the primary benchmark source, implementation files, dataset identity, run artifacts, model and provider settings, and inspection date. Ensure someone else can trace every numerical claim.
