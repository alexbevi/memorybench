import type { UnifiedSession } from "../../types/unified"

export function turns(session: UnifiedSession) {
  return session.messages
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: m.role,
      content: [
        m.timestamp && `Source date: ${m.timestamp}`,
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
