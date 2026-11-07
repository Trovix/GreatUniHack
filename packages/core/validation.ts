import { CompilationSchema, QuestionAnswerSchema, LIMITS, schemaErrors, type Bundle, type Compilation, type Dependency, type Evidence, type NarrationSegment, type QuestionAnswer } from './schemas';
import { uniqueIds, validateBundle, intervalsOverlap } from './input';
import { numericConsistencyErrors as validateNumericSupport } from './numeric';

/** Character locations in the selected plain-text cue, not fabricated word/audio byte offsets. */
export function locateQuote(text: string, quote: string): { start: number; end: number }[] {
  if (!quote) return [];
  const positions: { start: number; end: number }[] = [];
  for (let from = 0; from <= text.length - quote.length;) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    positions.push({ start: i, end: i + quote.length });
    from = i + 1;
  }
  return positions;
}

export function evidenceText(evidence: Evidence): string {
  // A visual observation/extraction is model output, NOT independently verified source truth.
  return evidence.kind === 'visual' ? [evidence.observation, evidence.extractedText].filter(Boolean).join('\n') : evidence.quote;
}

const stopWords = new Set(('a an the this that these those it its is are was were be been being has have had do does did can could would should may might will shall i we you they he she our your their of to at for from in on by with and or but if then than as so also which what when where who how why not no only all both each one two three four five six seven eight nine ten before after says said source lecture lecturer recording selected material evidence slide visual image diagram text information explain explanation answer adapted adaptation cannot determine identify establish unclear unresolved uncertain uncertainty limitation conflict conflicting contradict contradiction available supplied provided').split(' '));
export function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}][\p{L}\p{N}_-]*/gu) ?? []).filter(t => t.length > 1 && !stopWords.has(t)).map(t => t.replace(/(?:ing|ed|s)$/, '')));
}
function overlapScore(a: string, b: string): number {
  const aw = contentWords(a), bw = contentWords(b);
  if (!aw.size) return 1;
  return [...aw].filter(w => bw.has(w)).length / aw.size;
}
function sameText(a: string, b: string): boolean { return a.toLowerCase().replace(/\s+/g, ' ').includes(b.toLowerCase().replace(/\s+/g, ' ')); }
function repeatedRefs(refs: string[], label: string, errors: string[]): void {
  if (new Set(refs).size !== refs.length) errors.push(`${label}: duplicate reference IDs`);
}
function references(refs: string[], map: Map<string, unknown>, label: string, errors: string[]): void {
  repeatedRefs(refs, label, errors);
  for (const id of refs) if (!map.has(id)) errors.push(`${label}: unknown ID ${id}`);
}
const limitationPattern = /\b(?:cannot|can['’]t|could not|unable to|does not|doesn['’]t|not (?:shown|visible|readable|identified|specified|established|determinable)|unresolved|unclear|ambiguous|illegible|unreadable|unknown|insufficient|missing|not enough|no (?:pointer|selection|highlight|evidence))\b/i;
const conflictPattern = /\b(?:conflict\w*|contradict\w*|disagree\w*|inconsisten\w*|does not match|do not match|whereas|while the (?:slide|chart|recording|lecturer))\b/i;
export function hasNarratedLimitation(text: string): boolean { return limitationPattern.test(text); }
export function hasNarratedConflict(text: string): boolean { return conflictPattern.test(text); }

function limitationCovered(segment: NarrationSegment, dependency: Dependency): boolean {
  const reason = dependency.uncertaintyReason ?? '';
  const marker = dependency.status === 'conflict' ? hasNarratedConflict(segment.text) : hasNarratedLimitation(segment.text);
  return marker && !!reason && (sameText(segment.text, reason) || overlapScore(reason, segment.text) >= 0.25);
}

/**
 * Structural/provenance/lexical gates. Passing is NOT proof of image interpretation,
 * complete dependency detection, pedagogical accuracy, or blind-user accessibility.
 */
export function validateCompilation(value: Compilation, bundle: Bundle, revision: number): string[] {
  const parsed = CompilationSchema.safeParse(value);
  if (!parsed.success) return schemaErrors(parsed.error, 'compilation');
  const c = parsed.data;
  const errors = validateBundle(bundle).map(e => `Source input: ${e}`);
  if (!Number.isSafeInteger(revision) || revision < 1 || c.inputRevision !== revision) errors.push(`Compilation revision ${c.inputRevision} does not match current input revision ${revision}`);
  uniqueIds(c.evidence, 'evidence', errors); uniqueIds(c.dependencies, 'dependencies', errors); uniqueIds(c.claims, 'claims', errors); uniqueIds(c.segments, 'segments', errors);
  // IDs are globally unique across output namespaces so an ID cannot change meaning by record kind.
  uniqueIds([...c.evidence, ...c.dependencies, ...c.claims, ...c.segments], 'compilation records', errors);
  const cues = new Map(bundle.cues.map(x => [x.id, x]));
  const states = new Map(bundle.timeline.map(x => [x.stateId, x]));
  const documents = new Map((bundle.context ?? []).map(x => [x.id, x]));
  const evidence = new Map(c.evidence.map(x => [x.id, x]));
  const dependencies = new Map(c.dependencies.map(x => [x.id, x]));
  const claims = new Map(c.claims.map(x => [x.id, x]));
  const duration = bundle.assets.find(a => a.id === bundle.audioAssetId)?.durationMs ?? 0;
  const outputText = c.segments.reduce((n, s) => n + s.text.length, 0);
  if (outputText > LIMITS.maxOutputChars) errors.push('Narration exceeds aggregate output text limit');

  for (const e of c.evidence) {
    if (e.kind === 'speech') {
      const cue = cues.get(e.cueId);
      if (!cue) errors.push(`Evidence ${e.id}: unknown cue ${e.cueId}`);
      else {
        if (!locateQuote(cue.text, e.quote).length) errors.push(`Evidence ${e.id}: quote is not an exact substring of cue ${e.cueId}`);
        if (e.sourceStartMs < cue.startMs || e.sourceEndMs > cue.endMs || e.sourceEndMs <= e.sourceStartMs) errors.push(`Evidence ${e.id}: time range is outside cue ${e.cueId} or has no duration`);
      }
    } else if (e.kind === 'visual') {
      if (!states.has(e.stateId)) errors.push(`Evidence ${e.id}: unknown visual state ${e.stateId}`);
      // RegionSchema enforces coordinates. It cannot determine whether the model read the crop correctly.
    } else {
      const d = documents.get(e.documentId);
      if (!d) errors.push(`Evidence ${e.id}: unknown selected context ${e.documentId}`);
      else if (!locateQuote(d.text, e.quote).length) errors.push(`Evidence ${e.id}: quote is not an exact substring of selected context ${e.documentId}`);
    }
  }

  for (const d of c.dependencies) {
    references(d.cueIds, cues, `Dependency ${d.id} cues`, errors);
    references(d.stateIds, states, `Dependency ${d.id} states`, errors);
    references(d.evidenceIds, evidence, `Dependency ${d.id} evidence`, errors);
    if (!d.cueIds.length && !d.stateIds.length) errors.push(`Dependency ${d.id}: no source cue or visual state anchors`);
    const anchoredCues = d.cueIds.flatMap(id => cues.get(id) ? [cues.get(id)!] : []);
    // A broad narration range cannot turn a later slide into the referent of
    // an earlier utterance. Earlier states remain available for comparisons.
    if (anchoredCues.length) for (const stateId of d.stateIds) {
      const occurrences = bundle.timeline.filter(entry => entry.stateId === stateId);
      if (occurrences.length && occurrences.every(entry => anchoredCues.every(cue => entry.startMs >= cue.endMs))) {
        errors.push(`Dependency ${d.id}: visual state ${stateId} occurs only after its source cues`);
      }
    }
    const de = d.evidenceIds.flatMap(id => evidence.get(id) ? [evidence.get(id)!] : []);
    for (const e of de) {
      if (e.kind === 'speech' && !d.cueIds.includes(e.cueId)) errors.push(`Dependency ${d.id}: cited speech ${e.id} is not one of its cue anchors`);
      if (e.kind === 'visual' && !d.stateIds.includes(e.stateId)) errors.push(`Dependency ${d.id}: cited visual ${e.id} is not one of its state anchors`);
    }
    if (d.status === 'resolved' || d.status === 'already_audible') {
      if (!d.resolution) errors.push(`Dependency ${d.id}: resolved/already-audible records need a stated resolution`);
      if (!de.length) errors.push(`Dependency ${d.id}: resolution has no evidence`);
      if (d.status === 'already_audible' && !de.some(e => e.kind === 'speech')) errors.push(`Dependency ${d.id}: already-audible meaning requires speech evidence`);
      if (d.resolution) errors.push(...validateNumericSupport(d.resolution, de.map(evidenceText)).map(e => `Dependency ${d.id}: ${e}`));
    } else {
      if (!d.uncertaintyReason) errors.push(`Dependency ${d.id}: unresolved/conflict records need a specific uncertainty reason`);
      if (d.resolution) errors.push(`Dependency ${d.id}: an unresolved/conflict record must not present an asserted resolution`);
      if (d.status === 'conflict' && de.length < 2) errors.push(`Dependency ${d.id}: a source conflict needs both sides of its evidence`);
    }
    if (d.essential) {
      const segments = c.segments.filter(s => s.dependencyIds.includes(d.id));
      if (!segments.length) errors.push(`Essential dependency ${d.id} is not linked to any narrated segment`);
      if (d.status === 'unresolved' || d.status === 'conflict') {
        if (!segments.some(s => limitationCovered(s, d))) errors.push(`Essential dependency ${d.id}: its specific limitation/conflict is not narrated`);
        for (const s of segments) {
          if (d.status === 'conflict' && s.status !== 'conflict') errors.push(`Segment ${s.id}: conflicted dependency ${d.id} must remain conflict, not supported`);
          if (d.status === 'unresolved' && s.status === 'supported') errors.push(`Segment ${s.id}: unresolved essential dependency ${d.id} cannot be supported`);
        }
      } else if (d.resolution && !segments.some(s => sameText(s.text, d.resolution!) || overlapScore(d.resolution!, s.text) >= 0.25)) errors.push(`Essential dependency ${d.id}: stated resolution is not represented in linked narration`);
    }
  }

  const expectedUnresolved = c.dependencies.filter(d => d.essential && (d.status === 'unresolved' || d.status === 'conflict')).map(d => d.id);
  references(c.unresolvedEssentialIds, dependencies, 'unresolvedEssentialIds', errors);
  for (const id of expectedUnresolved) if (!c.unresolvedEssentialIds.includes(id)) errors.push(`unresolvedEssentialIds omits ${id}`);
  for (const id of c.unresolvedEssentialIds) if (!expectedUnresolved.includes(id)) errors.push(`unresolvedEssentialIds incorrectly includes resolved/nonessential ${id}`);

  for (const claim of c.claims) {
    references(claim.evidenceIds, evidence, `Claim ${claim.id} evidence`, errors);
    references(claim.dependencyIds, dependencies, `Claim ${claim.id} dependencies`, errors);
    const ce = claim.evidenceIds.flatMap(id => evidence.get(id) ? [evidence.get(id)!] : []);
    if (claim.kind !== 'uncertainty' && !ce.length) errors.push(`Claim ${claim.id}: material claim has no evidence`);
    if (claim.kind === 'lecturer_claim' && !ce.some(e => e.kind === 'speech')) errors.push(`Claim ${claim.id}: lecturer claim needs speech evidence`);
    if (claim.kind === 'visual_fact' && !ce.some(e => e.kind === 'visual')) errors.push(`Claim ${claim.id}: visual fact needs visual evidence`);
    if (claim.kind === 'context' && !ce.some(e => e.kind === 'context')) errors.push(`Claim ${claim.id}: selected-context claim needs context evidence`);
    if (claim.kind === 'uncertainty' && !claim.dependencyIds.some(id => ['unresolved', 'conflict'].includes(dependencies.get(id)?.status ?? ''))) errors.push(`Claim ${claim.id}: uncertainty must link to the unresolved/conflicting dependency it describes`);
    errors.push(...validateNumericSupport(claim.meaning, ce.map(evidenceText)).map(e => `Claim ${claim.id}: ${e}`));
    if (ce.length && overlapScore(claim.meaning, ce.map(evidenceText).join(' ')) === 0 && claim.kind !== 'uncertainty') errors.push(`Claim ${claim.id}: cited evidence has no informative textual connection to this assertion; source review is required`);
    if (!c.segments.some(s => s.claimIds.includes(claim.id))) errors.push(`Claim ${claim.id} is not represented by a narrated segment`);
  }

  for (const s of c.segments) {
    references(s.claimIds, claims, `Segment ${s.id} claims`, errors);
    references(s.dependencyIds, dependencies, `Segment ${s.id} dependencies`, errors);
    references(s.stateIds, states, `Segment ${s.id} states`, errors);
    if (!s.claimIds.length) errors.push(`Segment ${s.id}: narration must be linked to its claims`);
    for (const r of s.sourceRanges) if (r.endMs > duration || r.startMs < 0) errors.push(`Segment ${s.id}: source range extends beyond current source audio`);
    const sc = s.claimIds.flatMap(id => claims.get(id) ? [claims.get(id)!] : []);
    const se = [...new Set(sc.flatMap(claim => claim.evidenceIds))].flatMap(id => evidence.get(id) ? [evidence.get(id)!] : []);
    for (const claim of sc) {
      for (const id of claim.dependencyIds) if (!s.dependencyIds.includes(id)) errors.push(`Segment ${s.id}: omits dependency ${id} referenced by its claim ${claim.id}`);
    }
    for (const e of se) {
      if (e.kind === 'speech' && !s.sourceRanges.some(r => intervalsOverlap(r, { startMs: e.sourceStartMs, endMs: e.sourceEndMs }))) errors.push(`Segment ${s.id}: cited speech ${e.id} has no matching source range`);
      if (e.kind === 'visual' && !s.stateIds.includes(e.stateId)) errors.push(`Segment ${s.id}: cited visual ${e.id} is absent from its state mapping`);
    }
    for (const stateId of s.stateIds) {
      if (!bundle.timeline.some(t => t.stateId === stateId && s.sourceRanges.some(r => intervalsOverlap(r, t)))) errors.push(`Segment ${s.id}: state ${stateId} is not aligned with any declared source range`);
    }
    const support = se.map(evidenceText);
    errors.push(...validateNumericSupport(s.text, support).map(e => `Segment ${s.id}: ${e}`));
    if (s.status === 'supported' && s.dependencyIds.some(id => { const d = dependencies.get(id); return d?.essential && (d.status === 'unresolved' || d.status === 'conflict'); })) errors.push(`Segment ${s.id}: supported status conceals an essential source gap`);
    if (s.status === 'incomplete' && !hasNarratedLimitation(s.text)) errors.push(`Segment ${s.id}: incomplete status needs an audible source limitation`);
    if (s.status === 'conflict' && !hasNarratedConflict(s.text)) errors.push(`Segment ${s.id}: conflict status needs an audible conflict disclosure`);
    if (support.length && overlapScore(s.text, [...support, ...sc.map(claim => claim.meaning)].join(' ')) < 0.1) errors.push(`Segment ${s.id}: narration is not textually grounded in its cited claims/evidence`);
  }
  for (const cue of bundle.cues) if (!c.segments.some(s => s.sourceRanges.some(r => intervalsOverlap(r, cue)))) errors.push(`Source cue ${cue.id} has no mapped narration; coverage cannot be silently omitted`);
  return [...new Set(errors)];
}

/** Context-sensitive review flags; the words themselves are not automatic failures. */
export function compilationWarnings(c: Compilation): string[] {
  const warnings = ['Automated checks do not establish semantic accuracy or accessibility; visual observations and extracted text are not human-verified.'];
  if (c.sourceReview === 'not_reviewed') warnings.push('This adaptation has not been source-reviewed by a person.');
  if (c.providerMode === 'mock') warnings.push('Mock adaptation: software-path test only, not multimodal interpretation.');
  for (const s of c.segments) if (/\b(?:as you can see|this curve|over here|that one|these values|look at|the highlighted)\b/i.test(s.text)) warnings.push(`Segment ${s.id}: review visual-reference language in context; already-explained referents may be harmless.`);
  return warnings;
}

/** The answer's scope is its cited source set, not all numeric facts in a lecture. */
export function validateAnswer(value: QuestionAnswer, compilation: Compilation, bundle: Bundle): string[] {
  const parsed = QuestionAnswerSchema.safeParse(value);
  if (!parsed.success) return schemaErrors(parsed.error, 'answer');
  const a = parsed.data;
  const errors: string[] = [];
  const ep = new Map(compilation.evidence.map(e => [e.id, e]));
  references(a.evidenceIds, ep, 'Answer evidence', errors);
  const cited = a.evidenceIds.flatMap(id => ep.get(id) ? [ep.get(id)!] : []);
  const support = cited.map(evidenceText);
  // Recheck cited provenance so a previously persisted/provider-supplied compilation cannot launder it.
  for (const e of cited) {
    if (e.kind === 'speech') {
      const cue = bundle.cues.find(c => c.id === e.cueId);
      if (!cue || !locateQuote(cue.text, e.quote).length || e.sourceStartMs < cue.startMs || e.sourceEndMs > cue.endMs || e.sourceEndMs <= e.sourceStartMs) errors.push(`Answer evidence ${e.id}: invalid quote, cue, or source time`);
    } else if (e.kind === 'context') {
      const d = bundle.context?.find(d => d.id === e.documentId);
      if (!d || !locateQuote(d.text, e.quote).length) errors.push(`Answer evidence ${e.id}: invalid selected-context quote`);
    } else if (!bundle.timeline.some(t => t.stateId === e.stateId)) errors.push(`Answer evidence ${e.id}: unknown visual state`);
  }
  if (a.status === 'supported' && !cited.length) errors.push('Supported answers require cited source evidence');
  errors.push(...validateNumericSupport(a.text, support).map(e => `Answer: ${e}`));
  const relevant = compilation.dependencies.filter(d =>
    d.essential && ['unresolved', 'conflict'].includes(d.status) &&
    (d.evidenceIds.some(id => a.evidenceIds.includes(id)) || cited.some(e => e.kind === 'visual' && d.stateIds.includes(e.stateId) || e.kind === 'speech' && d.cueIds.includes(e.cueId))));
  if (relevant.some(d => d.status === 'conflict') && a.status !== 'conflict') errors.push('Answer must preserve the conflict in its cited source set');
  if (relevant.some(d => d.status === 'unresolved') && a.status === 'supported') errors.push('Answer cannot resolve an essential source ambiguity merely by citing it');
  if (a.status === 'limitation' && !hasNarratedLimitation(a.text)) errors.push('Limitation answer must actually state what the source cannot determine');
  if (a.status === 'conflict' && !hasNarratedConflict(a.text)) errors.push('Conflict answer must actually disclose the source disagreement');
  for (const d of relevant) if (d.uncertaintyReason && !(sameText(a.text, d.uncertaintyReason) || overlapScore(d.uncertaintyReason, a.text) >= 0.25)) errors.push(`Answer does not explain the relevant source limitation ${d.id}`);
  // A limitation label must not be used to launder a definite choice/repair after a disclaimer.
  if (relevant.some(d => d.status === 'unresolved') && /\b(?:therefore|so|hence|thus|but|however)\b[^.!?]{0,100}\b(?:choose|use|select|selected|correct option|answer is|must be)\b/i.test(a.text)) errors.push('Answer asserts a selection despite unresolved source evidence');
  if (a.status === 'supported') {
    const groundedClaims = compilation.claims.filter(c => c.evidenceIds.length > 0 && c.evidenceIds.every(id => a.evidenceIds.includes(id))).map(c => c.meaning);
    if (overlapScore(a.text, [...support, ...groundedClaims].join(' ')) < 0.2) errors.push('Answer assertion has insufficient textual grounding in its cited evidence; valid IDs alone are not support');
  }
  return [...new Set(errors)];
}

export function assertCurrentRevision(expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1 || expected !== actual) throw new Error('STALE_REVISION: source inputs changed; discard this derived result');
}

export function isCompilationCurrent(compilation: Pick<Compilation, 'inputRevision'> | undefined, revision: number): boolean {
  return !!compilation && Number.isSafeInteger(revision) && revision > 0 && compilation.inputRevision === revision;
}
