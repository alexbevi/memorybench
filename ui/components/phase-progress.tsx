"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Tooltip } from "@/components/tooltip"
import type { QuestionCheckpoint } from "@/lib/api"
import { getIngestionProgress } from "@/lib/ingestion-progress"

interface PhaseProgressProps {
  questions?: Record<string, QuestionCheckpoint>
  isRunning?: boolean
  summary: {
    total: number
    ingested: number
    indexed: number
    searched: number
    answered: number
    evaluated: number
    indexingEpisodes?: {
      total: number
      completed: number
      failed: number
    }
  }
}

const phases = [
  { key: "ingested", label: "Ingest" },
  { key: "indexed", label: "Index" },
  { key: "searched", label: "Search" },
  { key: "answered", label: "Answer" },
  { key: "evaluated", label: "Evaluate" },
] as const

export function PhaseProgress({ summary, questions, isRunning = false }: PhaseProgressProps) {
  const [lockedEpisodes, setLockedEpisodes] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const [justClicked, setJustClicked] = useState(false)
  const ingestion = questions ? getIngestionProgress(questions, summary.total) : undefined
  const readiness = Object.values(questions ?? {}).filter(
    (q) => q.phases.indexing.status === "in_progress" && q.phases.indexing.readiness
  )

  return (
    <div className="card">
      <style jsx>{`
        @keyframes shimmer {
          0% {
            background-position: -200% 0;
          }
          100% {
            background-position: 200% 0;
          }
        }
        .shimmer-bar {
          background: linear-gradient(
            90deg,
            #3b82f6 0%,
            #60a5fa 25%,
            #93c5fd 50%,
            #60a5fa 75%,
            #3b82f6 100%
          );
          background-size: 200% 100%;
          animation: shimmer 2s linear infinite;
        }
      `}</style>
      <h3 className="text-sm font-medium text-text-primary mb-4">Pipeline Progress</h3>
      <div className="flex items-center gap-2">
        {phases.map((phase) => {
          const count = summary[phase.key]
          const progress =
            phase.key === "ingested" && ingestion
              ? ingestion.percent
              : summary.total > 0
                ? (count / summary.total) * 100
                : 0
          const isComplete = summary.total > 0 && count === summary.total
          const isInProgress = progress > 0 && !isComplete
          const isPending = progress === 0
          const waitingForFirstSession =
            phase.key === "ingested" &&
            isRunning &&
            ingestion &&
            ingestion.active.length > 0 &&
            progress === 0

          const episodes = summary.indexingEpisodes
          const canToggleEpisodes =
            phase.key === "indexed" && episodes && episodes.total > 0 && !isComplete

          const shouldPreview = isHovering && !justClicked
          const isShowingEpisodes =
            canToggleEpisodes && (shouldPreview ? !lockedEpisodes : lockedEpisodes)

          const displayLabel = isShowingEpisodes ? "Receipts ready" : phase.label
          const displayCount = isShowingEpisodes ? episodes.completed : count
          const displayTotal = isShowingEpisodes ? episodes.total : summary.total
          const displayProgress = isShowingEpisodes
            ? (episodes.completed / episodes.total) * 100
            : progress

          if (canToggleEpisodes) {
            const content = (
              <div
                className="flex-1 cursor-pointer"
                onMouseEnter={() => setIsHovering(true)}
                onMouseLeave={() => {
                  setIsHovering(false)
                  setJustClicked(false)
                }}
                onClick={() => {
                  setLockedEpisodes(!lockedEpisodes)
                  setJustClicked(true)
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-text-secondary">{displayLabel}</span>
                  <span className="text-xs font-mono text-text-muted">
                    {displayCount}/{displayTotal}
                    {isShowingEpisodes && episodes.failed > 0 && (
                      <span className="text-status-error ml-1">({episodes.failed} failed)</span>
                    )}
                  </span>
                </div>
                <div className="h-2 bg-bg-elevated overflow-hidden">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      isShowingEpisodes && "shimmer-bar",
                      !isShowingEpisodes && isComplete && "bg-status-success",
                      !isShowingEpisodes && isInProgress && "bg-accent",
                      !isShowingEpisodes && isPending && "bg-transparent"
                    )}
                    style={{ width: `${displayProgress}%` }}
                  />
                </div>
              </div>
            )

            return (
              <Tooltip key={phase.key} className="flex-1" content="Click to toggle">
                {content}
              </Tooltip>
            )
          }

          return (
            <div key={phase.key} className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-text-secondary">{phase.label}</span>
                <span className="text-xs font-mono text-text-muted">
                  {count}/{summary.total}
                </span>
              </div>
              <div className="h-2 bg-bg-elevated overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-all duration-500",
                    isComplete && "bg-status-success",
                    isInProgress && "bg-accent",
                    isPending && !waitingForFirstSession && "bg-transparent",
                    waitingForFirstSession && "shimmer-bar"
                  )}
                  style={{ width: waitingForFirstSession ? "100%" : `${progress}%` }}
                  role="progressbar"
                  aria-label={`${phase.label} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={waitingForFirstSession ? undefined : progress}
                />
              </div>
            </div>
          )
        })}
      </div>
      {summary.indexingEpisodes && summary.indexingEpisodes.total > 0 && (
        <p className="mt-3 text-xs text-text-secondary" aria-live="polite">
          Readiness: {summary.indexingEpisodes.completed}/{summary.indexingEpisodes.total} receipts
          confirmed ready · {summary.indexed}/{summary.total} questions ready
          {summary.ingested < summary.total && " · checks begin after ingestion finishes"}
        </p>
      )}
      {isRunning && readiness.length > 0 && (
        <div className="mt-2 text-xs text-text-secondary" aria-live="polite">
          <p>
            Atlas readiness checks require a 180-second minimum wait after a session's last write,
            searchable episodes, and 60 seconds of unchanged episode contents.
          </p>
          <ul className="mt-2 space-y-1">
            {readiness.map((q) => {
              const detail = q.phases.indexing.readiness!
              const labels = {
                pending: "not checked",
                grace: "minimum wait",
                episodes: "waiting for episodes",
                search: "waiting for searchability",
                stability: "stability wait",
              }
              return (
                <li key={q.questionId}>
                  <span className="font-mono">{q.questionId}</span>: {detail.readySessions}/
                  {detail.totalSessions} sessions ready
                  {Object.entries(detail.waiting)
                    .filter(([, count]) => count > 0)
                    .map(
                      ([reason, count]) => ` · ${count} ${labels[reason as keyof typeof labels]}`
                    )}
                  {detail.checkingSession && ` · checking ${detail.checkingSession}`}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {ingestion && (ingestion.savedSessions > 0 || ingestion.active.length > 0) && (
        <div className="mt-3 text-xs text-text-secondary" aria-live="polite">
          <p>
            {ingestion.savedSessions} sessions saved · {summary.ingested}/{summary.total} questions
            fully ingested
          </p>
          {isRunning && ingestion.active.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
              {ingestion.active.map((question) => (
                <li key={question.questionId}>
                  <span className="font-mono">{question.questionId}</span>: {question.completed}
                  {question.total !== undefined ? `/${question.total}` : ""} sessions
                  {question.completed === 0 && " · processing first session"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
