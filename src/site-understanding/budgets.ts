/** Validated finite exploration limits used by the browser loop and CLI. */
import { z } from "zod";

export const DEFAULT_BUDGETS = {
  maxPages: 24,
  maxInteractions: 40,
  maxDurationSeconds: 600,
  maxOrigins: 1,
} as const;

export const BudgetSchema = z.object({
  maxPages: z.number().int().min(1).max(500),
  maxInteractions: z.number().int().min(0).max(2_000),
  maxDurationSeconds: z.number().int().min(1).max(7_200),
  // Explicit understanding allowlists may span many service origins, while a
  // finite ceiling still prevents an accidentally unbounded browser run.
  maxOrigins: z.number().int().min(1).max(500),
});
export type ExplorationBudget = z.infer<typeof BudgetSchema>;

/** Parse CLI overrides and reject non-finite or excessive budgets with field paths. */
export function parseBudgetOverrides(overrides: Partial<Record<keyof ExplorationBudget, string | number>>): ExplorationBudget {
  const values: Record<string, number> = { ...DEFAULT_BUDGETS };
  for (const [key, raw] of Object.entries(overrides)) {
    if (raw === undefined) continue;
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid budget ${key}: expected a finite number.`);
    values[key] = parsed;
  }
  const result = BudgetSchema.safeParse(values);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid exploration budget: ${details}`);
  }
  return result.data;
}
