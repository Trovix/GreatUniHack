/**
 * Deterministic screening, not mathematical or visual entailment. In particular,
 * model-observed text is still model output. A semantic audit/source review must
 * decide whether the cited image actually supports an observation or referent.
 */
const small: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const unitAliases: Record<string, string> = {
  '£': 'GBP', pound: 'GBP', pounds: 'GBP', '$': 'USD', dollar: 'USD', dollars: 'USD',
  '€': 'EUR', euro: 'EUR', euros: 'EUR', '%': '%', percent: '%', percentage: '%',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg', gram: 'g', grams: 'g', milligram: 'mg', milligrams: 'mg',
  millimetre: 'mm', millimetres: 'mm', millimeter: 'mm', millimeters: 'mm',
  metre: 'm', metres: 'm', meter: 'm', meters: 'm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  second: 's', seconds: 's', millisecond: 'ms', milliseconds: 'ms', minute: 'min', minutes: 'min', hour: 'h', hours: 'h',
  unit: 'units', units: 'units', volt: 'V', volts: 'V', amp: 'A', amps: 'A', newton: 'N', newtons: 'N',
  celsius: 'Celsius', fahrenheit: 'Fahrenheit', kelvin: 'K', litre: 'L', litres: 'L', liter: 'L', liters: 'L',
};
const shortUnitAliases: Record<string, string> = { m: 'm', cm: 'cm', mm: 'mm', g: 'g', s: 's', ms: 'ms', min: 'min', h: 'h', v: 'V', n: 'N', l: 'L' };

export type NumericFact = { value: string; unit?: string };
function canonicalNumber(value: number): string { return Object.is(value, -0) ? '0' : String(Number(value.toPrecision(13))); }
function numberWords(words: string[], start: number): { value: number; end: number } | undefined {
  let total = 0; let group = 0; let i = start; let seen = false; let last = '';
  if (words[i] === 'half') return { value: 0.5, end: i + 1 };
  if (words[i] === 'quarter') return { value: 0.25, end: i + 1 };
  for (; i < words.length; i++) {
    const word = words[i];
    if (word in small) {
      // "five seven" means two values, not twelve; twenty one means twenty-one.
      if (last in small && !(small[last] >= 20 && small[last] % 10 === 0 && small[word] > 0 && small[word] < 10)) break;
      group += small[word]; seen = true; last = word; continue;
    }
    if (word === 'hundred' && last !== 'hundred') { group = (group || 1) * 100; seen = true; last = word; continue; }
    if ((word === 'thousand' || word === 'million') && seen) { total += group * (word === 'thousand' ? 1000 : 1_000_000); group = 0; last = word; continue; }
    if (word === 'and' && seen && ['hundred', 'thousand', 'million'].includes(last) && words[i + 1] in small) { last = word; continue; }
    break;
  }
  if (!seen) return undefined;
  if (words[i] === 'point' && words[i + 1] in small && small[words[i + 1]] < 10) {
    const decimals: string[] = [];
    i++;
    while (words[i] in small && small[words[i]] < 10) decimals.push(String(small[words[i++]]));
    return { value: Number(`${total + group}.${decimals.join('')}`), end: i };
  }
  return { value: total + group, end: i };
}

function prepare(text: string): string {
  return text.normalize('NFKC').replace(/−/g, '-').replace(/(?<=\p{L})-(?=\p{L})/gu, ' ').toLowerCase()
    .replace(/\b([b-hj-z])\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (_, letter: string, word: string) => `${letter}${small[word]}`);
}

export function extractNumericFacts(text: string): NumericFact[] {
  const prepared = prepare(text);
  // Alphanumeric curve labels are identities, not quantities. They are compared separately.
  const withoutLabels = prepared.replace(/\b[a-z]+\d+[a-z0-9]*\b/g, ' ');
  const words = withoutLabels.match(/[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?|[a-z]+|[%£$€+*/^<>!=-]/g) ?? [];
  const facts: NumericFact[] = [];
  for (let i = 0; i < words.length;) {
    const start = i;
    let sign = 1;
    if (['negative', 'minus', '-'].includes(words[i])) { sign = -1; i++; }
    else if (['positive', 'plus', '+'].includes(words[i])) i++;
    const digit = /^[+-]?\d/.test(words[i] ?? '') ? { value: Number(words[i]), end: i + 1 } : undefined;
    const parsed = digit ?? numberWords(words, i);
    if (!parsed || !Number.isFinite(parsed.value)) { i = start + 1; continue; }
    i = parsed.end;
    const before = words[start - 1];
    let after = words[i];
    if (after === 'per' || after === 'and') after = '';
    const unit = ['£', '$', '€'].includes(before) ? unitAliases[before] : (unitAliases[after] ?? shortUnitAliases[after]);
    facts.push({ value: canonicalNumber(sign * parsed.value), ...(unit ? { unit } : {}) });
  }
  return facts;
}

export function extractNumericTokens(text: string): string[] {
  return [...new Set(extractNumericFacts(text).map(fact => fact.value))];
}

function labels(text: string): Set<string> {
  return new Set(prepare(text).match(/\b[a-z]+\d+[a-z0-9]*\b/g) ?? []);
}
function units(text: string): Set<string> {
  const result = new Set<string>();
  for (const token of prepare(text).match(/[a-z]+|[%£$€]/g) ?? []) if (unitAliases[token]) result.add(unitAliases[token]);
  for (const fact of extractNumericFacts(text)) if (fact.unit) result.add(fact.unit);
  return result;
}
function mathNormal(text: string): string {
  return prepare(text)
    .replace(/\bsum of ([a-z]) and ([a-z])\b/g, '$1 + $2')
    .replace(/\bdifference (?:of|between) ([a-z]) and ([a-z])\b/g, '$1 - $2')
    .replace(/\b(?:not equal to|not equal|does not equal|must not equal|cannot equal)\b/g, ' != ')
    .replace(/\b(?:less than or equal to|at most)\b/g, ' <= ').replace(/\b(?:greater than or equal to|at least)\b/g, ' >= ')
    .replace(/\b(?:plus or minus)\b/g, ' ± ').replace(/\bplus\b/g, ' + ').replace(/\bminus\b/g, ' - ')
    .replace(/\b(?:divided by|over)\b/g, ' / ').replace(/\b(?:multiplied by|times)\b/g, ' * ')
    .replace(/\b(?:equals|equal to)\b/g, ' = ').replace(/\bless than\b/g, ' < ').replace(/\bgreater than\b/g, ' > ')
    .replace(/≠/g, ' != ').replace(/≤/g, ' <= ').replace(/≥/g, ' >= ').replace(/×|·/g, ' * ');
}
function expressions(text: string): Set<string> {
  const normalized = mathNormal(text);
  const result = new Set<string>();
  const pattern = /\b([a-z]|\d+(?:\.\d+)?)\s*(!=|<=|>=|[+*/=<>-])\s*([a-z]|\d+(?:\.\d+)?)\b/g;
  for (const match of normalized.matchAll(pattern)) result.add(`${match[1]}${match[2]}${match[3]}`);
  return result;
}
function operators(text: string): Set<string> {
  // A hyphen in prose is not a minus sign. Only math-looking minus is included.
  const normalized = mathNormal(text);
  const values = normalized.match(/!=|<=|>=|[+*/=<>±]|(?<=\w)\s*-\s*(?=\w)/g) ?? [];
  return new Set(values.map(value => value.trim()));
}

/** Compare only the evidence cited for this claim, never the entire lecture. */
export function numericConsistencyErrors(output: string, citedSourceTexts: readonly string[]): string[] {
  const sources = citedSourceTexts.join('\n');
  const sourceFacts = extractNumericFacts(sources);
  const values = new Set(sourceFacts.map(fact => fact.value));
  const sourceUnits = units(sources);
  const sourceLabels = labels(sources);
  const sourceExpressions = expressions(sources);
  const sourceOperators = operators(sources);
  const errors: string[] = [];
  for (const fact of extractNumericFacts(output)) {
    // This is a canonical restriction of a displayed fraction, not a new measured value.
    const denominatorZero = fact.value === '0' && /\bdenominator\b[^.!?]{0,60}\b(?:not|never|cannot|non)\b[^.!?]{0,30}\bzero\b/i.test(output) && sourceOperators.has('/') && sourceOperators.has('!=');
    if (!values.has(fact.value) && !denominatorZero) errors.push(`Unsupported numeric value ${fact.value}`);
    if (fact.unit && !sourceUnits.has(fact.unit)) errors.push(`Unsupported unit or currency ${fact.unit}`);
    const candidates = sourceFacts.filter(source => source.value === fact.value);
    if (fact.unit && candidates.length && candidates.every(source => source.unit && source.unit !== fact.unit)) errors.push(`Value ${fact.value} is assigned an unsupported unit ${fact.unit}`);
  }
  for (const unit of units(output)) if (!sourceUnits.has(unit)) errors.push(`Unsupported unit or currency ${unit}`);
  for (const label of labels(output)) if (!sourceLabels.has(label)) errors.push(`Unsupported numbered label ${label}`);
  for (const expression of expressions(output)) if (!sourceExpressions.has(expression)) errors.push(`Unsupported sign, order or relation in ${expression}`);
  for (const operator of operators(output)) if (!sourceOperators.has(operator)) errors.push(`Unsupported mathematical operator ${operator}`);
  // Exact/rephrased-negation screening intentionally avoids claiming general entailment.
  const sentences = (text: string) => text.toLowerCase().split(/[.!?\n]+/).map(sentence => sentence.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const skeleton = (sentence: string) => sentence.replace(/\b(?:not|never)\b/g, '').replace(/\s+/g, ' ').trim();
  for (const statement of sentences(output)) {
    for (const source of sentences(sources)) if (statement.length > 15 && skeleton(statement) === skeleton(source) && /\b(?:not|never)\b/.test(statement) !== /\b(?:not|never)\b/.test(source)) errors.push('Source negation was changed');
  }
  return [...new Set(errors)];
}
