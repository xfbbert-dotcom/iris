/** A contradiction detector for explicit binary calculations, not a semantic
 * verifier. No model-authored expression, eval(), or inferred business operand.
 * Unrecognized/quoted/negated expressions remain the semantic reviewer's job. */
export type PdCalculation = {
  start: number; end: number; quote: string; operator: string;
  left: string; right: string; claimed: string; matches: boolean;
};

const decimal = "[+\\-−－负]?[ \\t]*[0-9]{1,18}(?:\\.[0-9]{1,9})?";
const unit = "(?:亿元|万元|元|亿|万|人|个|天|小时|%)?";
const quantity = `(${decimal})[ \\t]*(${unit})`;
const operator = "([+\\-−－*×/÷]|加上|加|减去|减|乘以|乘|除以)";
// A noun label may intervene, but it must never swallow a sign or operator.
const label = "(?:(?!加|减|乘|除|负|正|不)[\\p{Script=Han}]){0,12}?";
const equation = new RegExp(`${quantity}[ \\t]*${operator}[ \\t]*${label}${quantity}[ \\t]*(?:[=＝]|等于|[，,][ \\t]*(?:差额|余额|结果|合计|总额)(?:为|是))[ \\t]*${quantity}`, "gu");
type Rational = { n: bigint; d: bigint; dimension: string };

function value(text: string, unitText: string): Rational {
  const cleaned = text.replace(/[ \t]/gu, "").replace(/[−－负]/gu, "-");
  const [whole, fraction = ""] = cleaned.split(".");
  const scale = unitText.startsWith("亿") ? 100_000_000n : unitText.startsWith("万") ? 10_000n : 1n;
  const dimension = unitText.endsWith("元") ? "元" : unitText === "万" || unitText === "亿" ? "scaled" : unitText;
  return { n: BigInt(`${whole}${fraction}`) * scale, d: 10n ** BigInt(fraction.length), dimension };
}

function calculate(a: Rational, b: Rational, op: string): Rational | null {
  if (["+", "加", "加上", "-", "−", "－", "减", "减去"].includes(op)) {
    if (a.dimension !== b.dimension) return null;
    const sign = ["+", "加", "加上"].includes(op) ? 1n : -1n;
    return { n: a.n * b.d + sign * b.n * a.d, d: a.d * b.d, dimension: a.dimension };
  }
  if (["*", "×", "乘", "乘以"].includes(op)) {
    if (a.dimension && b.dimension) return null;
    return { n: a.n * b.n, d: a.d * b.d, dimension: a.dimension || b.dimension };
  }
  if (b.n === 0n || (b.dimension && a.dimension !== b.dimension)) return null;
  return { n: a.n * b.d, d: a.d * b.n, dimension: b.dimension ? "" : a.dimension };
}

export function inspectPdCalculations(text: string): PdCalculation[] {
  const found: PdCalculation[] = [];
  for (const match of text.matchAll(equation)) {
    const start = match.index!;
    const end = start + match[0].length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    // Never reinterpret a suffix of a number, chained expression or parenthesis
    // as an independent equation. Unsupported grammar is not a positive proof.
    if (/[0-9A-Za-z.,，+\-−－×*/÷()（）=＝]\s*$/u.test(before)
      || /(?:加上?|减去?|乘以?|除以|等于)\s*$/u.test(before)
      || /^\s*(?:[0-9A-Za-z.,+\-−－×*/÷()（）=＝%]|加|减|乘|除|等于)/u.test(after)) continue;
    const sentenceStart = Math.max(before.lastIndexOf("。"), before.lastIndexOf("；"), before.lastIndexOf("\n")) + 1;
    const sentenceEndOffset = after.search(/[。；\n]/u);
    const sentence = text.slice(sentenceStart, sentenceEndOffset < 0 ? text.length : end + sentenceEndOffset);
    if (/[“”‘’「」『』"'`?？]/u.test(sentence)
      || /不是|并非|不等于|不成立|不正确|不对|错|有误|误写|误算|不能|不应|应为|假设|如果|若/u.test(sentence)) continue;
    const a = value(match[1]!, match[2]!);
    const b = value(match[4]!, match[5]!);
    const c = value(match[6]!, match[7]!);
    const computed = calculate(a, b, match[3]!);
    if (computed === null || computed.dimension !== c.dimension) continue;
    found.push({ start, end, quote: match[0], operator: match[3]!,
      left: match[1]! + match[2]!, right: match[4]! + match[5]!, claimed: match[6]! + match[7]!,
      matches: computed.n * c.d === c.n * computed.d });
  }
  return found;
}
