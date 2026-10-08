import { expect, test } from "bun:test"
import { locomoAnswerF1, tokenF1 } from "./scoring"
test("answer F1 normalizes tokens and counts multiplicity", () => {
  expect(tokenF1("The adoption agencies.", "adoption agency")).toBe(1)
  expect(tokenF1("Paris Paris London", "Paris London")).toBe(0.8)
  expect(tokenF1("", "Paris")).toBe(0)
})
test("category aggregation separates multi-answer and abstention scoring", () => {
  expect(locomoAnswerF1("psychology", "psychology, counseling", "multi-hop")).toBe(0.5)
  expect(locomoAnswerF1("Paris", "Paris; explanation", "world-knowledge")).toBe(1)
  expect(locomoAnswerF1("I don't know", "Not mentioned", "adversarial")).toBeUndefined()
})
