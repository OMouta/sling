import { expect } from "vitest";

/**
 * Checks a time budget in milliseconds. CI's shared runners measure two to
 * three times slower than a developer machine on every timing, so on CI the
 * budget isn't checked and the test only reports what it measured.
 */
export function withinBudget(ms: number, budget: number): void {
  if (process.env.CI) return;
  expect(ms).toBeLessThan(budget);
}
