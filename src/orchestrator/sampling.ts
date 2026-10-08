import type { SamplingConfig } from "../types/checkpoint"

export const DEFAULT_SAMPLE_SEED = "memorybench-v1"
type Question = { questionId: string; questionType: string; metadata?: Record<string, unknown> }

function randomSource(seed: string) {
  let state = 2166136261
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619)
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function selectQuestionsBySampling(all: Question[], sampling: SamplingConfig): string[] {
  if (sampling.mode === "full") return all.map((q) => q.questionId)
  const count = sampling.mode === "limit" ? sampling.limit : sampling.perCategory
  if (!Number.isSafeInteger(count) || count! <= 0)
    throw new Error("Sample size must be a positive integer")
  if (sampling.mode === "limit") return all.slice(0, count).map((q) => q.questionId)
  const type = sampling.sampleType ?? "stratified"
  if (!["consecutive", "random", "stratified"].includes(type))
    throw new Error("Invalid sample type")
  const random = randomSource(String(sampling.seed ?? DEFAULT_SAMPLE_SEED))
  const byType = new Map<string, Question[]>()
  for (const q of all) byType.set(q.questionType, [...(byType.get(q.questionType) ?? []), q])
  const selected: string[] = []
  for (const category of [...byType.keys()].sort()) {
    const questions = byType.get(category)!
    if (type === "consecutive") selected.push(...questions.slice(0, count).map((q) => q.questionId))
    else if (type === "random")
      selected.push(
        ...shuffle(questions, random)
          .slice(0, count)
          .map((q) => q.questionId)
      )
    else {
      const groups = new Map<string, Question[]>()
      for (const q of questions) {
        const conversation = String(q.metadata?.sampleId ?? q.questionId)
        groups.set(conversation, [...(groups.get(conversation) ?? []), q])
      }
      const buckets = shuffle(
        [...groups.values()].map((g) => shuffle(g, random)),
        random
      )
      let remaining = count!
      while (remaining > 0 && buckets.some((g) => g.length)) {
        for (const group of buckets) {
          if (!remaining) break
          const q = group.pop()
          if (q) {
            selected.push(q.questionId)
            remaining--
          }
        }
      }
    }
  }
  return selected
}
