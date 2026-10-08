import type { Provider, SearchOptions } from "../types/provider"
export interface SearchMeasurement {
  warmupRequests: number
  repetitions: number
}
export function searchMeasurementOptions(value?: Partial<SearchMeasurement>): SearchMeasurement {
  const warmupRequests = value?.warmupRequests ?? 0,
    repetitions = value?.repetitions ?? 1
  if (
    !Number.isInteger(warmupRequests) ||
    warmupRequests < 0 ||
    warmupRequests > 10 ||
    !Number.isInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 20
  )
    throw new Error("Search warmups must be 0–10 and repetitions 1–20")
  return { warmupRequests, repetitions }
}
export async function measureSearch(
  provider: Pick<Provider, "search">,
  query: string,
  options: SearchOptions,
  measurement?: SearchMeasurement
) {
  const policy = searchMeasurementOptions(measurement)
  for (let i = 0; i < policy.warmupRequests; i++) await provider.search(query, options)
  const samples: number[] = []
  let results: unknown[] = []
  for (let i = 0; i < policy.repetitions; i++) {
    const started = performance.now()
    const response = await provider.search(query, options)
    samples.push(performance.now() - started)
    // Answer from the first measured result; never cherry-pick evidence across repetitions.
    if (i === 0) results = response
  }
  return { results, samples, measurement: policy }
}
