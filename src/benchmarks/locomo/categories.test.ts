import { expect, test } from "bun:test"
import { CATEGORY_TO_TYPE } from "./index"
import { getJudgePromptForType, TEMPORAL_JUDGE_PROMPT } from "../../prompts/defaults"

test("official LoCoMo category IDs drive labels and temporal judging", () => {
  // https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py
  expect(CATEGORY_TO_TYPE).toEqual({
    1: "multi-hop",
    2: "temporal",
    3: "world-knowledge",
    4: "single-hop",
    5: "adversarial",
  })
  expect(getJudgePromptForType(CATEGORY_TO_TYPE[2])).toBe(TEMPORAL_JUDGE_PROMPT)
  expect(getJudgePromptForType(CATEGORY_TO_TYPE[3])).not.toBe(TEMPORAL_JUDGE_PROMPT)
})
