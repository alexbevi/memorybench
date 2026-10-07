import type { UnifiedMessage, UnifiedSession } from "../types/unified"

/** Preserve source attribution in content, even when a provider ignores metadata. */
export function sourceMessageHeader(message: UnifiedMessage, session: UnifiedSession): string {
  const date = message.timestamp ?? session.metadata?.date
  return [
    `Source session: ${session.sessionId}`,
    typeof date === "string" && `Source date: ${date}`,
    message.speaker && `Speaker: ${message.speaker}`,
    `Role: ${message.role}`,
  ]
    .filter(Boolean)
    .join("\n")
}

export function sourceMessages(session: UnifiedSession) {
  return session.messages
    .filter((message) => message.content.trim())
    .map((message) => ({
      role: message.role,
      content: `${sourceMessageHeader(message, session)}\n${message.content}`,
    }))
}
