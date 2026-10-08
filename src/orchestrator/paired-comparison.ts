import type { BenchmarkResult } from "../types/unified"

export interface PairedComparison {
  providers: [string, string]
  matchedQuestions: number
  conversations: number
  leftOnlyCorrect: number
  rightOnlyCorrect: number
  bothCorrect: number
  bothIncorrect: number
  accuracyDifference: number
  disagreements: {
    questionId: string
    question: string
    leftAnswer: string
    rightAnswer: string
    leftCorrect: boolean
  }[]
  warnings: string[]
}
export function pairedComparisons(
  reports: { provider: string; report: BenchmarkResult }[]
): PairedComparison[] {
  const pairs: PairedComparison[] = []
  for (let i = 0; i < reports.length; i++)
    for (let j = i + 1; j < reports.length; j++) {
      const left = reports[i],
        right = reports[j]
      const byId = new Map(right.report.evaluations.map((e) => [e.questionId, e]))
      const result: PairedComparison = {
        providers: [left.provider, right.provider],
        matchedQuestions: 0,
        conversations: 0,
        leftOnlyCorrect: 0,
        rightOnlyCorrect: 0,
        bothCorrect: 0,
        bothIncorrect: 0,
        accuracyDifference: 0,
        disagreements: [],
        warnings: [],
      }
      const conversations = new Set<string>()
      for (const a of left.report.evaluations) {
        const b = byId.get(a.questionId)
        if (!b || a.question !== b.question || a.groundTruth !== b.groundTruth) continue
        result.matchedQuestions++
        conversations.add(a.questionId.replace(/-q\d+$/, ""))
        const ac = a.score === 1,
          bc = b.score === 1
        if (ac && bc) result.bothCorrect++
        else if (!ac && !bc) result.bothIncorrect++
        else {
          if (ac) result.leftOnlyCorrect++
          else result.rightOnlyCorrect++
          result.disagreements.push({
            questionId: a.questionId,
            question: a.question,
            leftAnswer: a.hypothesis,
            rightAnswer: b.hypothesis,
            leftCorrect: ac,
          })
        }
      }
      result.conversations = conversations.size
      result.accuracyDifference = result.matchedQuestions
        ? (result.leftOnlyCorrect - result.rightOnlyCorrect) / result.matchedQuestions
        : 0
      if (
        result.matchedQuestions !== left.report.evaluations.length ||
        result.matchedQuestions !== right.report.evaluations.length
      )
        result.warnings.push(
          "Question coverage or ground truth differs; only matching questions are paired."
        )
      if (!result.matchedQuestions) result.warnings.push("No matching evaluated questions.")
      if (left.report.benchmark === "locomo" && conversations.size < 10)
        result.warnings.push(
          `This sample covers ${conversations.size}/10 LoCoMo conversations; do not treat it as a dataset-wide ranking.`
        )
      if (
        left.report.judge !== right.report.judge ||
        left.report.answeringModel !== right.report.answeringModel
      )
        result.warnings.push("Answering or judging models differ.")
      const a = left.report.provenance,
        b = right.report.provenance
      if (!a || !b)
        result.warnings.push(
          "Legacy or unrecorded provenance: shared input and answer policies cannot be verified."
        )
      else if (
        a.code.sourceHash !== b.code.sourceHash ||
        a.datasetHash !== b.datasetHash ||
        a.answerPolicy !== b.answerPolicy ||
        a.inputPolicy !== b.inputPolicy ||
        a.retrievalPolicy !== b.retrievalPolicy
      )
        result.warnings.push("Code, data, or evaluation policies differ.")
      if (left.report.readinessPolicy?.method !== right.report.readinessPolicy?.method)
        result.warnings.push(
          "Readiness methods differ; indexing latency is not the same operation for both providers."
        )
      if (
        JSON.stringify(left.report.searchMeasurement) !==
        JSON.stringify(right.report.searchMeasurement)
      )
        result.warnings.push("Search warmup or repetition settings differ.")
      pairs.push(result)
    }
  return pairs
}
