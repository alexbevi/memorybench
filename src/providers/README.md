# Providers

Memory provider integrations. Each provider implements the `Provider` interface.

## Interface

```typescript
interface Provider {
    name: string
    prompts?: ProviderPrompts
    initialize(config: ProviderConfig): Promise<void>
    ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
    awaitIndexing(result: IngestResult, containerTag: string): Promise<void>
    search(query: string, options: SearchOptions): Promise<unknown[]>
    clear(containerTag: string): Promise<void>
}
```

## Adding a Provider

1. Create `src/providers/myprovider/index.ts`
2. Implement `Provider` interface
3. Register in `src/providers/index.ts`
4. Add to `ProviderName` type in `src/types/provider.ts`
5. Add config in `src/utils/config.ts`

**Required returns:**
- `initialize()` - Set up client with API key
- `ingest()` - Return `{ documentIds: string[], taskIds?: string[] }`
- `awaitIndexing()` - Wait for async indexing to complete
- `search()` - Return array of results (provider-specific format)
- `clear()` - Delete data by containerTag

## Custom Prompts

Providers can override answer generation and judge prompts via `ProviderPrompts`:

```typescript
interface ProviderPrompts {
    answerPrompt?: string | ((question: string, context: unknown[], questionDate?: string) => string)
    judgePrompt?: (question: string, groundTruth: string, hypothesis: string) => { default: string, [type: string]: string }
}
```

**Answer Prompt:** Transform search results into an LLM prompt. Function receives raw search results.

**Judge Prompt:** Return prompts keyed by question type. Must include `default`. Falls back to built-in prompts if not provided.

Example: See `src/providers/zep/prompts.ts`

## Existing Providers

| Provider | SDK | Notes |
|----------|-----|-------|
| `supermemory` | `supermemory` | Raw JSON sessions |
| `mem0` | `mem0ai` | Cloud v2 API, graph disabled |
| `mem0-local` | REST via `fetch` | [Standalone server setup and validation](mem0-local/README.md), graph disabled by default |
| `zep` | `@getzep/zep-cloud` | Graph-based, custom prompts |

Benchmark answering uses `src/prompts/answer.ts` for every provider. Provider
`answerPrompt` values are legacy and are not used by the answer phase. The shared
policy uses ranked evidence up to 8,000 context tokens, at most 1,000 output tokens,
and temperature 0 where supported. The selected answering model is run-level;
comparisons must use the same model. See each answer checkpoint's `answerPolicy`
for the policy version, model, budget, and truncation counts.
