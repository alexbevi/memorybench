export interface QuestionTypeInfo {
  id: string
  alias: string
  description: string
}

export type QuestionTypeRegistry = Record<string, QuestionTypeInfo>

export interface UnifiedMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  speaker?: string
}

export interface UnifiedSession {
  sessionId: string
  messages: UnifiedMessage[]
  metadata?: Record<string, unknown>
}

export interface UnifiedQuestion {
  questionId: string
  question: string
  questionType: string
  groundTruth: string
  haystackSessionIds: string[]
  metadata?: Record<string, unknown>
}

export type SearchResult = unknown

export interface RetrievalMetrics {
  hitAtK: number
  precisionAtK: number

  mrr: number
  ndcg: number
  k: number
  relevantRetrieved: number
}

export interface RetrievalAggregates {
  hitAtK: number
  precisionAtK: number

  mrr: number
  ndcg: number
  k: number
}

export interface EvaluationResult {
  answerF1?: number
  answerF1Version?: string
  questionId: string
  questionType: string
  question: string
  score: number
  label: "correct" | "incorrect"
  explanation: string
  hypothesis: string
  groundTruth: string
  searchResults: SearchResult[]
  searchDurationMs: number
  answerDurationMs: number
  totalDurationMs: number
  retrievalMetrics?: RetrievalMetrics
}

export interface LatencyStats {
  min: number
  max: number
  mean: number
  median: number
  p95: number
  p99: number
  stdDev: number
  count: number
}

export interface QuestionTypeStats {
  total: number
  correct: number
  accuracy: number
  latency: {
    search: LatencyStats
    answer: LatencyStats
    total: LatencyStats
  }
  retrieval?: RetrievalAggregates
}

export interface TokenMetrics {
  totalTokens: number
  basePromptTokens: number
  contextTokens: number
  avgTokensPerQuestion: number
  avgBasePromptTokens: number
  avgContextTokens: number
}

export interface BenchmarkResult {
  searchMeasurement?: import("../orchestrator/search-measurement").SearchMeasurement
  provenance?: import("../utils/provenance").RunProvenance
  answerF1?: { mean: number; count: number; version: string }
  readinessPolicy?: import("./provider").ReadinessPolicy
  provider: string
  benchmark: string
  runId: string
  dataSourceRunId: string
  judge: string
  answeringModel: string
  timestamp: string
  summary: {
    totalQuestions: number
    correctCount: number
    accuracy: number
  }
  latency: {
    ingest: LatencyStats
    indexing: LatencyStats
    search: LatencyStats
    answer: LatencyStats
    evaluate: LatencyStats
    total: LatencyStats
  }
  tokens?: TokenMetrics
  memscore?: string
  memscoreComponents?: { quality: number; latencyMs: number; contextTokens: number }
  retrieval?: RetrievalAggregates
  byQuestionType: Record<string, QuestionTypeStats>
  questionTypeRegistry?: QuestionTypeRegistry
  evaluations: EvaluationResult[]
}
