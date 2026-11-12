export const currentEvaluation = candidate => candidate.ai_pending ? undefined : candidate.history?.[0]?.result;
export const aiStatus = candidate => candidate.ai_pending ? 'pending' : candidate.history?.length ? 'evaluated' : 'unevaluated';
export const contacts = candidate => [candidate.phone && '手机', candidate.email && '邮箱', candidate.wechat && '微信', candidate.link && '平台入口'].filter(Boolean);
export const importedAt = candidate => Date.parse(candidate.created) || 0;
export const hasFilterValue = value => value !== undefined && value !== null && value !== '';
const nameOrder = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true });
const includes = (value, query) => String(value || '').toLowerCase().includes(String(query || '').trim().toLowerCase());

function matchesContact(candidate, filter) {
  if (filter === 'available' || filter === 'missing') return Boolean(contacts(candidate).length) === (filter === 'available');
  return !filter || Boolean(candidate[filter]);
}

export function filterAndSort(candidates, filters = {}, sort = 'created-desc') {
  const from = filters.createdFrom ? Date.parse(`${filters.createdFrom}T00:00:00+08:00`) : null;
  const until = filters.createdTo ? Date.parse(`${filters.createdTo}T00:00:00+08:00`) + 86400000 : null;
  const rows = candidates.filter(candidate => {
    const result = currentEvaluation(candidate);
    const score = result?.score;
    const timestamp = Date.parse(candidate.created);
    return (!hasFilterValue(filters.job) || candidate.job_id === filters.job) &&
      (!filters.review || candidate.review === filters.review) &&
      (!filters.ai || aiStatus(candidate) === filters.ai) &&
      (!filters.category || result?.category === filters.category) &&
      (!filters.mustHave || result?.must_have_status === filters.mustHave) &&
      matchesContact(candidate, filters.contact) &&
      (!filters.search || includes([candidate.name, candidate.resume, candidate.company, candidate.title,
        candidate.city, candidate.education, candidate.skills].filter(Boolean).join(' '), filters.search)) &&
      ['company', 'title', 'city', 'education'].every(key => !filters[key] || includes(candidate[key], filters[key])) &&
      (!hasFilterValue(filters.minScore) || Number.isFinite(score) && score >= Number(filters.minScore)) &&
      (!hasFilterValue(filters.maxScore) || Number.isFinite(score) && score <= Number(filters.maxScore)) &&
      (from === null || Number.isFinite(from) && Number.isFinite(timestamp) && timestamp >= from) &&
      (until === null || Number.isFinite(until) && Number.isFinite(timestamp) && timestamp < until);
  });
  const [field, direction] = sort.split('-');
  const order = direction === 'desc' ? -1 : 1;
  return rows.sort((a, b) => {
    const newest = b.id - a.id;
    if (field === 'name') return order * nameOrder.compare(a.name || '', b.name || '') || newest;
    if (field === 'created') return order * (importedAt(a) - importedAt(b)) || newest;
    if (field === 'score') {
      const left = currentEvaluation(a)?.score, right = currentEvaluation(b)?.score;
      if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : newest;
      if (!Number.isFinite(right)) return -1;
      return order * (left - right) || newest;
    }
    return field === 'oldest' ? -newest : newest;
  });
}
