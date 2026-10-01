import { z } from "zod";

export type PdCalculationSource = { ref: string; text: string };
const quantityBindingSchema = z.object({
  sourceRef: z.string().min(1).max(200),
  contextQuote: z.string().min(1).max(1000).regex(/\S/u),
  quantityQuote: z.string().min(1).max(160).regex(/\S/u),
}).strict();
export const pdSourceCalculationQuantitiesSchema = z.object({ count: quantityBindingSchema,
  unitCost: quantityBindingSchema, budget: quantityBindingSchema, priorUnitCost: quantityBindingSchema.nullable() }).strict();
type Binding = z.infer<typeof quantityBindingSchema>;
type Role = "count" | "unitCost" | "budget" | "priorUnitCost";
export type PdSourceCalculation = {
  text: string;
  bindings: { ref: string; quote: string; role: Role; quantityQuote: string }[];
  values: { total: string; budget: string; difference: string; previousTotal: string | null; increase: string | null };
};

const precision = 1_000_000n;
const countWords: Record<string, bigint> = { 一: 1n, 二: 2n, 两: 2n, 三: 3n, 四: 4n, 五: 5n,
  六: 6n, 七: 7n, 八: 8n, 九: 9n, 十: 10n };
const moneyLiteral = /^([0-9]{1,12}(?:\.[0-9]{1,6})?)\s*(亿元|万元|元|亿|万)$/u;
const countLiteral = /^([0-9]{1,6}|[一二两三四五六七八九十])\s*(个人|人|个|台|件|份|项|套|批|座|辆)$/u;

// Verify literal location against the full source, not a conveniently shortened
// context that hides a numeric sign or a prefix of a larger number.
function bound(binding: Binding, sources: readonly PdCalculationSource[]): boolean {
  const matches = sources.filter(source => source.ref === binding.sourceRef);
  if (matches.length !== 1 || binding.quantityQuote !== binding.quantityQuote.trim()) return false;
  const text = matches[0]!.text;
  for (let contextAt = text.indexOf(binding.contextQuote); contextAt !== -1;
    contextAt = text.indexOf(binding.contextQuote, contextAt + 1)) {
    for (let quoteAt = binding.contextQuote.indexOf(binding.quantityQuote); quoteAt !== -1;
      quoteAt = binding.contextQuote.indexOf(binding.quantityQuote, quoteAt + 1)) {
      const start = contextAt + quoteAt;
      const before = text.slice(0, start);
      const after = text.slice(start + binding.quantityQuote.length);
      if (/[\p{Nd}A-Za-z一二两三四五六七八九十百千万亿零〇点负./／+＋\-−－]\s*$/u.test(before)
        || /[\p{Nd}一二两三四五六七八九十零〇][,，．]\s*$/u.test(before)
        || /^[\p{Nd}一二两三四五六七八九十百千万亿零〇元人个台件份项套批座辆%％]/u.test(after)) continue;
      return true;
    }
  }
  return false;
}
function money(quote: string): bigint | null {
  const match = moneyLiteral.exec(quote);
  if (!match) return null;
  const [whole, fraction = ""] = match[1]!.split(".");
  const scale = match[2]!.startsWith("亿") ? 100_000_000n : match[2]!.startsWith("万") ? 10_000n : 1n;
  return (BigInt(whole!) * precision + BigInt(fraction.padEnd(6, "0"))) * scale;
}
function count(quote: string): bigint | null {
  const match = countLiteral.exec(quote);
  return match ? countWords[match[1]!] ?? BigInt(match[1]!) : null;
}
function decimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const remainder = (absolute % precision).toString().padStart(6, "0").replace(/0+$/u, "");
  return sign + (absolute / precision).toString() + (remainder ? `.${remainder}` : "");
}
function display(value: bigint): string {
  return value % (1000n * precision) === 0n ? `${decimal(value / 10000n)}万元` : `${decimal(value)}元`;
}

/** Literal binding and exact arithmetic ONLY. Source authority is the caller's
 * responsibility. The semantic reviewer must check selected roles, per-unit
 * meaning, omissions, object/currency identity and current/prior applicability.
 * Prior totals use the SAME selected count, not a proven historical count.
 * In particular, swapping budget/price or current/prior remains locally valid.
 */
export function compilePdSourceCalculation(sources: readonly PdCalculationSource[], quantities: unknown): PdSourceCalculation | null {
  const parsed = pdSourceCalculationQuantitiesSchema.safeParse(quantities);
  if (!parsed.success) return null;
  const plan = parsed.data;
  const bindings: PdSourceCalculation["bindings"] = [];
  for (const role of ["count", "unitCost", "budget", "priorUnitCost"] as const) {
    const binding = plan[role];
    if (binding === null) continue;
    if (!bound(binding, sources)) return null;
    bindings.push({ ref: binding.sourceRef, quote: binding.contextQuote, role, quantityQuote: binding.quantityQuote });
  }
  const n = count(plan.count.quantityQuote);
  const unitCost = money(plan.unitCost.quantityQuote);
  const budget = money(plan.budget.quantityQuote);
  const prior = plan.priorUnitCost === null ? null : money(plan.priorUnitCost.quantityQuote);
  if (n === null || unitCost === null || budget === null || (plan.priorUnitCost !== null && prior === null)) return null;
  const total = n * unitCost;
  const previousTotal = prior === null ? null : n * prior;
  const increase = previousTotal === null ? null : total - previousTotal;
  const difference = total - budget;
  let text = `按数量${plan.count.quantityQuote}、单价${display(unitCost)}计算，总成本${display(total)}`;
  if (increase !== null && previousTotal !== null) {
    text += `；按相同数量计算，原单价对应成本${display(previousTotal)}`;
    text += increase === 0n ? "，当前总成本与之相同"
      : `，当前总成本比它${increase > 0n ? "增加" : "减少"}${display(increase < 0n ? -increase : increase)}`;
  }
  text += difference === 0n ? `，与预算${display(budget)}相等。`
    : `，比预算${display(budget)}${difference > 0n ? "多" : "少"}${display(difference < 0n ? -difference : difference)}。`;
  return { text, bindings, values: { total: decimal(total), budget: decimal(budget), difference: decimal(difference),
    previousTotal: previousTotal === null ? null : decimal(previousTotal), increase: increase === null ? null : decimal(increase) } };
}
