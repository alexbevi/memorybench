import { stemmer } from "stemmer"

// LoCoMo-style answer F1, separate from the LLM judge and retrieval metrics.
// Category aggregation follows task_eval/evaluation.py. This JS Porter stemmer
// differs from NLTK's extended Porter variant; do not label this published LoCoMo F1.
export const ANSWER_F1_VERSION = "locomo-style-porter-js-v1"
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[!"#$%&'()*+\-./:;<=>?@[\\\]^_`{|}~]/g, "")
    .replace(/\b(a|an|the|and)\b/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(stemmer)
}
export function tokenF1(prediction: string, reference: string): number {
  const actual = tokens(prediction),
    expected = tokens(reference)
  const counts = new Map<string, number>()
  for (const word of expected) counts.set(word, (counts.get(word) ?? 0) + 1)
  let common = 0
  for (const word of actual)
    if (counts.get(word)) {
      common++
      counts.set(word, counts.get(word)! - 1)
    }
  return common ? (2 * common) / (actual.length + expected.length) : 0
}
export function locomoAnswerF1(
  prediction: string,
  reference: string,
  type: string
): number | undefined {
  // Abstention is a separate task: absence of evidence has no positive token answer.
  if (type === "adversarial") return undefined
  if (type === "world-knowledge") reference = reference.split(";")[0].trim()
  if (type !== "multi-hop") return tokenF1(prediction, reference)
  const predictions = prediction.split(",").map((s) => s.trim())
  const references = reference.split(",").map((s) => s.trim())
  return (
    references.reduce(
      (sum, expected) => sum + Math.max(...predictions.map((actual) => tokenF1(actual, expected))),
      0
    ) / references.length
  )
}
