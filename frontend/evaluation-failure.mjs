export function candidateEvaluationFailure(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const failure = Object.prototype.hasOwnProperty.call(candidate, 'evaluation_failure')
    ? candidate.evaluation_failure : candidate.screening_failure;
  return failure && typeof failure === 'object' && !Array.isArray(failure)
    && typeof failure.message === 'string' && failure.message.trim() ? failure : null;
}
