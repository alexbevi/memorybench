export type JudgePromptResult = Record<string, string> & { default: string }
export type JudgePromptFunction = (
  question: string,
  groundTruth: string,
  hypothesis: string
) => JudgePromptResult

export interface ProviderPrompts {
  /** Legacy provider prompt; benchmark answering always uses the shared answer policy. */
  answerPrompt?: string | ((question: string, context: unknown[], questionDate?: string) => string)
  judgePrompt?: JudgePromptFunction
}

export function buildContextString(context: unknown[]): string {
  return JSON.stringify(context, null, 2)
}
