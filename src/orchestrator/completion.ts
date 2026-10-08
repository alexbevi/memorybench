import type { PhaseId, RunCheckpoint } from "../types/checkpoint"

// Validate only requested work. A report requires evaluated answers, while an
// ingest-only run can complete without running the remaining pipeline.
export function assertRequestedPhasesComplete(
  checkpoint: RunCheckpoint,
  phases: PhaseId[],
  questionIds: string[]
): void {
  const required = new Set(phases.filter((phase) => phase !== "report"))
  if (phases.includes("report")) required.add("evaluate")
  const incomplete: string[] = []
  for (const id of questionIds) {
    const question = checkpoint.questions[id]
    for (const phase of required) {
      const validAnswer = question?.phases.answer.hypothesis?.trim()
      if (question?.phases[phase].status !== "completed" ||
          ((phase === "answer" || phase === "evaluate") && !validAnswer)) {
        incomplete.push(`${id}:${phase}`)
      }
    }
  }
  if (incomplete.length) {
    throw new Error(`Run incomplete: ${incomplete.join(", ")}. Resume the unfinished phases before reporting results.`)
  }
}
