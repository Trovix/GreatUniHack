import { validateAnswer, type Bundle, type Compilation, type QuestionAnswer } from '../../packages/core/index.js';

const STOP = new Set('what which where when why how who is are was were the a an to of and or in on for do does did this that these those it me tell please explain can could would should from with'.split(' '));
const tokens = (text: string) => text.toLowerCase().match(/[a-z]{2,}|\d+(?:\.\d+)?/g)?.filter(word => !STOP.has(word)) ?? [];
const LIMITATION = 'The selected lecture material does not establish an answer to this question. I cannot add facts that are not supported by these sources.';

/** Conservative local retrieval, not a generative tutor. Only approved, cited text is spoken. */
export function groundedAnswer(question: string, segmentId: string, compilation: Compilation, bundle: Bundle): QuestionAnswer {
  const current = compilation.segments.find(segment => segment.id === segmentId);
  if (!current) return { text: LIMITATION, evidenceIds: [], status: 'limitation' };
  const overlapsCurrent = (cueId: string, stateId?: string) => {
    const cue = bundle.cues.find(cue => cue.id === cueId);
    return !!cue && current.sourceRanges.some(range => range.startMs < cue.endMs && cue.startMs < range.endMs)
      || !!stateId && bundle.timeline.some(entry => entry.stateId === stateId && current.sourceRanges.some(range => range.startMs < entry.endMs && entry.startMs < range.endMs));
  };
  const ambiguous = compilation.dependencies.filter(dependency => dependency.essential && ['unresolved', 'conflict'].includes(dependency.status)
    && (current.dependencyIds.includes(dependency.id) || dependency.cueIds.some(id => overlapsCurrent(id)) || dependency.stateIds.some(id => overlapsCurrent('', id))));
  const conflicts = ambiguous.some(dependency => dependency.status === 'conflict');
  if (ambiguous.length) {
    const affected = compilation.segments.filter(segment => segment.dependencyIds.some(id => ambiguous.some(dependency => dependency.id === id))
      && segment.sourceRanges.some(range => current.sourceRanges.some(other => range.startMs < other.endMs && other.startMs < range.endMs)));
    const relatedClaims = compilation.claims.filter(claim => affected.some(segment => segment.claimIds.includes(claim.id)));
    // Reuse checked specific disclosures, but fail closed even for an unlinked
    // persisted ledger: never return an empty response or invent a selection.
    const disclosure = affected.length ? affected.map(segment => segment.text).join(' ')
      : ambiguous.map(dependency => dependency.uncertaintyReason ?? 'The relevant source meaning is unresolved.').join(' ');
    const policy = conflicts ? 'The sources conflict. I will not choose either version or silently reconcile them.'
      : 'The recording does not identify the missing visual meaning. I will not choose an option without source evidence.';
    const text = `${disclosure} ${policy}`;
    if (text.length > 12000) return { text: `${ambiguous.map(dependency => dependency.uncertaintyReason).filter(Boolean).join(' ')} ${policy}`.slice(0, 12000), evidenceIds: [...new Set(ambiguous.flatMap(dependency => dependency.evidenceIds))], status: conflicts ? 'conflict' : 'limitation' };
    return { text, evidenceIds: [...new Set([...ambiguous.flatMap(dependency => dependency.evidenceIds), ...relatedClaims.flatMap(claim => claim.evidenceIds)])], status: conflicts ? 'conflict' : 'limitation' };
  }
  if (!current || current.status !== 'supported') return { text: LIMITATION, evidenceIds: [], status: 'limitation' };
  const query = tokens(question);
  if (!query.length) return { text: LIMITATION, evidenceIds: [], status: 'limitation' };
  // Questions are scoped to the current pedagogical segment and its overlapping sources.
  const eligible = compilation.segments.filter(segment => segment.status === 'supported' && (segment.id === segmentId || segment.sourceRanges.some(range => current.sourceRanges.some(other => range.startMs < other.endMs && range.endMs > other.startMs))));
  const ranked = eligible.map(segment => ({ segment, score: query.reduce((score, word) => score + (tokens(segment.text).includes(word) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score === 0) return { text: LIMITATION, evidenceIds: [], status: 'limitation' };
  const claims = compilation.claims.filter(claim => best.segment.claimIds.includes(claim.id));
  const answer: QuestionAnswer = {
    text: best.segment.text,
    evidenceIds: [...new Set(claims.flatMap(claim => claim.evidenceIds))],
    status: 'supported',
  };
  if (answer.text.length > 2400 || validateAnswer(answer, compilation, bundle).length) return { text: LIMITATION, evidenceIds: [], status: 'limitation' };
  return answer;
}
