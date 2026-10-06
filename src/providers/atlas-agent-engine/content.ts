import type { UnifiedSession } from "../../types/unified"

export function turns(session: UnifiedSession) {
  return session.messages
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: m.role,
      content: [
        (m.timestamp || session.metadata?.date) &&
          `Source date: ${m.timestamp || session.metadata?.date}`,
        m.speaker && `Speaker: ${m.speaker}`,
        `${m.role}: ${m.content}`,
      ]
        .filter(Boolean)
        .join("\n"),
    }))
}

// Code-point offsets keep astral characters intact, including at overlap boundaries.
export function chunks(text: string) {
  const chars = Array.from(text)
  const result: { content: string; start: number; end: number }[] = []
  for (let start = 0; start < chars.length; ) {
    let end = Math.min(start + 1600, chars.length)
    if (end < chars.length) {
      const boundary = chars.slice(start + 800, end).lastIndexOf("\n")
      if (boundary >= 0) end = start + 800 + boundary + 1
    }
    result.push({ content: chars.slice(start, end).join(""), start, end })
    if (end === chars.length) break
    start = end - 320
  }
  return result
}

export function transcriptChunks(session: UnifiedSession) {
  return session.messages.flatMap((message, messageIndex) => {
    if (!message.content.trim()) return []
    const sourceDate = message.timestamp ?? session.metadata?.date
    const header = [
      typeof sourceDate === "string" && `Source date: ${sourceDate}`,
      message.speaker && `Speaker: ${message.speaker}`,
      `Role: ${message.role}`,
    ]
      .filter(Boolean)
      .join("\n")
    return chunks(message.content).map((part) => ({
      content: `${header}\n${part.content}`,
      metadata: {
        sourceSessionId: session.sessionId,
        sourceDate,
        messageIndex,
        start: part.start,
        end: part.end,
      },
    }))
  })
}
