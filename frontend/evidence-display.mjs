// Presentation only: preserve the first exact quote and never merge distinct claims.
export function evidenceDisplay(item = {}) {
  const rows = Array.isArray(item.evidence_quotes)
    ? item.evidence_quotes.filter(quote => typeof quote === 'string' && quote.trim()) : [];
  const source = rows.length ? rows : typeof item.evidence === 'string'
    ? item.evidence.split(/\r?\n/u).filter(quote => quote.trim()) : [];
  const seen = new Set();
  const quotes = [];
  let duplicateCount = 0;
  for (const quote of source) {
    const key = quote.replace(/\s+/gu, ' ').trim();
    if (seen.has(key)) {
      duplicateCount += 1;
    } else {
      seen.add(key);
      quotes.push(quote);
    }
  }
  const storedCount = item.evidence_duplicate_count;
  if (quotes.length && Number.isSafeInteger(storedCount) && storedCount >= 0 &&
      Number.isSafeInteger(duplicateCount + storedCount)) duplicateCount += storedCount;
  return { quotes, duplicateCount };
}

export function evidencePreview(quotes, maxQuotes = 3, maxCharacters = 320) {
  let count = 0;
  let characters = 0;
  for (const quote of quotes.slice(0, maxQuotes)) {
    if (count > 0 && characters + quote.length > maxCharacters) break;
    count += 1;
    characters += quote.length;
  }
  return {
    quotes: quotes.slice(0, count),
    needsExpansion: count < quotes.length || characters > maxCharacters,
    clipFirst: count === 1 && characters > maxCharacters,
  };
}
