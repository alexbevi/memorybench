import type { QuestionCheckpoint } from "./api"

export function getIngestionProgress(questions: Record<string, QuestionCheckpoint>, total: number) {
  let questionUnits = 0
  let savedSessions = 0
  const active: { questionId: string; completed: number; total?: number }[] = []
  for (const question of Object.values(questions)) {
    const ingest = question.phases.ingest
    const completed = new Set(ingest.completedSessions ?? [])
    const sessions = question.sessions && new Set(question.sessions.map((s) => s.sessionId))
    const saved = sessions ? [...completed].filter((id) => sessions.has(id)).length : completed.size
    savedSessions += saved
    if (ingest.status === "completed") questionUnits += 1
    else if (sessions?.size) questionUnits += saved / sessions.size
    if (ingest.status === "in_progress") {
      active.push({ questionId: question.questionId, completed: saved, total: sessions?.size })
    }
  }
  return {
    percent: total > 0 ? Math.min(100, (questionUnits / total) * 100) : 0,
    savedSessions,
    active,
  }
}
