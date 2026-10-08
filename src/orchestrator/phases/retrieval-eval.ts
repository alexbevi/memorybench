import type { RetrievalMetrics } from "../../types/unified"
import type { LanguageModel } from "ai"
import { generateText } from "ai"

interface RelevanceResult {
  id: string
  relevant: 0 | 1
}

async function evaluateAllChunks(
  model: LanguageModel,
  question: string,
  groundTruth: string,
  searchResults: unknown[]
): Promise<RelevanceResult[]> {
  if (searchResults.length === 0) return []

  const formattedResults = searchResults
    .map((result, index) => {
      const id = `result_${index + 1}`
      const content = JSON.stringify(result, null, 2)
      return `=== ${id} ===\n${content}`
    })
    .join("\n\n")

  const prompt = `You are evaluating search results for relevance to a question.

QUESTION:
${question}

EXPECTED ANSWER:
${groundTruth}

SEARCH RESULTS:
${formattedResults}

TASK:
For each search result, determine if it contains information relevant to answering the question.
A result is relevant if it contains content that helps answer the question or supports the expected answer.

Return a JSON array with your evaluation for each result:
[
  {"id": "result_1", "relevant": 1},
  {"id": "result_2", "relevant": 0},
  ...
]

Where:
- "id" is the result identifier (result_1, result_2, etc.)
- "relevant" is 1 if relevant, 0 if not relevant

Return ONLY the JSON array, no other text.`

  try {
    const response = await generateText({
      model,
      messages: [{ role: "user", content: prompt }],
    })

    const jsonMatch = response.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      return searchResults.map((_, i) => ({ id: `result_${i + 1}`, relevant: 0 as const }))
    }

    const parsed = JSON.parse(jsonMatch[0]) as RelevanceResult[]
    return parsed
  } catch {
    return searchResults.map((_, i) => ({ id: `result_${i + 1}`, relevant: 0 as const }))
  }
}

function calculateNDCG(relevanceScores: number[], idealRelevant: number): number {
  const dcg = relevanceScores.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2)
  }, 0)

  const idealScores = Array(relevanceScores.length).fill(0)
  for (let i = 0; i < Math.min(idealRelevant, idealScores.length); i++) {
    idealScores[i] = 1
  }
  const idcg = idealScores.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2)
  }, 0)

  return idcg > 0 ? dcg / idcg : 0
}

export async function calculateRetrievalMetrics(
  model: LanguageModel,
  question: string,
  groundTruth: string,
  searchResults: unknown[],
  k: number = 10
): Promise<RetrievalMetrics> {
  const resultsToEval = searchResults.slice(0, k)

  if (resultsToEval.length === 0) {
    return {
      hitAtK: 0,
      precisionAtK: 0,

      mrr: 0,
      ndcg: 0,
      k: 0,
      relevantRetrieved: 0,
    }
  }

  const relevanceResults = await evaluateAllChunks(model, question, groundTruth, resultsToEval)

  return scoreRetrievedResults(
    resultsToEval.map((_, i) => {
      const result = relevanceResults.find((r) => r.id === `result_${i + 1}`)
      return result?.relevant === 1 ? 1 : 0
    })
  )
}

// Relevance is judged only within retrieved results; corpus recall is unknown.
export function scoreRetrievedResults(relevanceScores: number[]): RetrievalMetrics {
  const relevantRetrieved = relevanceScores.filter((r) => r === 1).length
  const firstRelevantIndex = relevanceScores.findIndex((r) => r === 1)
  return {
    hitAtK: relevantRetrieved > 0 ? 1 : 0,
    precisionAtK: relevanceScores.length ? relevantRetrieved / relevanceScores.length : 0,
    mrr: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    ndcg: calculateNDCG(relevanceScores, relevantRetrieved),
    k: relevanceScores.length,
    relevantRetrieved,
  }
}
