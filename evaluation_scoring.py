"""Calculate a reproducible score from validated condition judgments."""

from collections.abc import Mapping
import re
import unicodedata


SCORING_VERSION = 'equal-weight-v4'
_EVIDENCE_RULE = ('满足得100%分；信息不足且basis=inferred、有非空推导说明和经服务端核验的原文证据，'
                  '按support_score得10%至90%分（10%一档，旧结果未填默认50%）；'
                  '其余信息不足（含完全无信息）及不满足得0分，全部条件计入分母')
SCORING_RULE = _EVIDENCE_RULE + '，各条件等权'
PRIORITY_SCORING_VERSION = 'priority-weight-v4'
PRIORITY_SCORING_RULE = _EVIDENCE_RULE + '，优先级按组数至1递减加权，同组条件等权'
_CREDIT_UNITS = {'满足': 10, '信息不足': 0, '不满足': 0}
_LIST_PREFIX = re.compile(
    r'^(?:(?:\d+\.(?!\d)|\d+[、)]|\(\d+\))\s*|'
    r'-(?!-)\s*|\*\s+|[•●▪◦‣·–—]\s*)'
)


def normalize_condition(condition):
    """Remove list prefixes and normalize spacing without rewriting the claim."""
    if not isinstance(condition, str):
        raise ValueError('condition 必须是非空字符串')
    value = unicodedata.normalize('NFKC', condition).strip()
    while True:
        match = _LIST_PREFIX.match(value)
        if match is None:
            break
        value = value[match.end():].strip()
    value = ' '.join(value.split()).casefold()
    if not value:
        raise ValueError('condition 必须是非空字符串')
    return value


def _credit_units(row, status, path):
    """Use integer tenths; only resolved evidence can support partial credit.

    Resume quotation validation belongs to the server before this function is
    called. Bare model line references or inferred labels are not evidence.
    """
    supplied = 'support_score' in row
    percent = row.get('support_score')
    if supplied and (type(percent) is not int or not 0 <= percent <= 100 or percent % 10):
        raise ValueError(f'{path}.support_score 必须为0到100之间的整数且以10为一档')
    if status != '信息不足':
        units = _CREDIT_UNITS[status]
        if supplied and percent != units * 10:
            raise ValueError(f'{path}.support_score 与{status}状态不一致，应为{units * 10}')
        return units
    reasoning = row.get('reasoning')
    evidence = row.get('evidence')
    quotes = row.get('evidence_quotes')
    has_evidence = isinstance(evidence, str) and bool(evidence.strip())
    has_quotes = (isinstance(quotes, list) and bool(quotes) and
                  all(isinstance(quote, str) and bool(quote.strip()) for quote in quotes))
    supported = (row.get('basis') == 'inferred' and isinstance(reasoning, str) and
                 bool(reasoning.strip()) and (has_evidence or has_quotes))
    if supported:
        if supplied and not 10 <= percent <= 90:
            raise ValueError(f'{path}.support_score 有证据的部分支持必须为10到90，且以10为一档')
        return percent // 10 if supplied else 5
    if supplied and percent != 0:
        raise ValueError(f'{path}.support_score 缺少合格的推导说明或原文证据时只能为0')
    return 0


def _condition_scores(judgments, labels, weights):
    """Describe each unique condition's contribution without mutating checks."""
    return [
        {
            'condition': labels[key],
            'status': status,
            'credit': 'full' if units == 10 else 'partial' if units else 'none',
            'support_score': units * 10,
            'ratio': units / 10,
            'weight': weights[key],
            'points': units * weights[key] / 10,
        }
        for key, (status, units) in sorted(judgments.items())
    ]


def calculate_score(checks, required_checks=(), priority_groups=None):
    """Score unique conditions; contradictory judgments must be repaired first.

    The immutable empty default represents an omitted required-check array.
    Inferred unknowns with resolved evidence and reasoning receive 10-90% credit.
    Older results without support_score retain their original 50% partial credit.
    Other unknowns and unmet conditions earn none. All remain in the denominator.
    Model-supplied overall scores and weights have no effect on the calculation.
    """
    judgments, labels = {}, {}
    for field, rows in (('checks', checks), ('required_checks', required_checks)):
        if not isinstance(rows, (list, tuple)):
            raise ValueError(f'{field} 必须是条件对象数组')
        for index, row in enumerate(rows):
            path = f'{field}[{index}]'
            if not isinstance(row, Mapping):
                raise ValueError(f'{path} 必须是条件对象')
            try:
                condition = normalize_condition(row.get('condition'))
            except ValueError:
                raise ValueError(f'{path}.condition 必须是非空字符串') from None
            status = row.get('status')
            if not isinstance(status, str) or status not in _CREDIT_UNITS:
                raise ValueError(f'{path}.status 只能为满足、不满足、信息不足')
            judgment = (status, _credit_units(row, status, path))
            previous = judgments.get(condition)
            if previous is not None and previous != judgment:
                raise ValueError('同一条件的判断状态或证据得分冲突，请统一后重新评估')
            judgments[condition] = judgment
            labels.setdefault(condition, row['condition'].strip())

    total = len(judgments)
    if not total:
        raise ValueError('至少需要一项非空条件，无法对空结果评分')
    met = sum(status == '满足' for status, _ in judgments.values())
    unknown = sum(status == '信息不足' for status, _ in judgments.values())
    partial = sum(0 < units < 10 for _, units in judgments.values())
    no_evidence = unknown - partial
    not_met = total - met - unknown
    points = sum(units for _, units in judgments.values())
    # Units are tenths of a condition; exact .5 percentage ties round up.
    score = (20 * points + total) // (2 * total)
    weights = dict.fromkeys(judgments, 1)
    result = {
        'score': score,
        'scoring': {
            'version': SCORING_VERSION,
            'total': total,
            'met': met,
            'unknown': unknown,
            'partial': partial,
            'no_evidence': no_evidence,
            'not_met': not_met,
            'rule': SCORING_RULE,
            'condition_scores': _condition_scores(judgments, labels, weights),
        },
    }
    if priority_groups is None or priority_groups == []:
        return result
    if not isinstance(priority_groups, list) or len(priority_groups) > total:
        raise ValueError('优先级必须是分组数组且组数不能超过条件数量')

    seen, layout, weights = set(), [], {}
    for index, group in enumerate(priority_groups):
        if not isinstance(group, list) or not group:
            raise ValueError('每个优先级分组必须是非空条件数组')
        weight = len(priority_groups) - index
        conditions = []
        for value in group:
            condition = normalize_condition(value)
            if condition not in judgments or condition in seen:
                raise ValueError('优先级包含重复或不属于评估的条件')
            seen.add(condition)
            weights[condition] = weight
            conditions.append(labels[condition])
        layout.append({'priority': index + 1, 'weight': weight, 'conditions': conditions})
    if seen != judgments.keys():
        raise ValueError('优先级必须完整覆盖全部条件，不得漏项')

    weighted_total = sum(weights.values())
    weighted_met = sum(weights[key] for key, (status, _) in judgments.items() if status == '满足')
    weighted_unknown = sum(weights[key] for key, (status, _) in judgments.items() if status == '信息不足')
    weighted_partial = sum(weights[key] for key, (_, units) in judgments.items() if 0 < units < 10)
    weighted_no_evidence = weighted_unknown - weighted_partial
    weighted_not_met = weighted_total - weighted_met - weighted_unknown
    weighted_points = sum(weights[key] * units for key, (_, units) in judgments.items())
    result['score'] = (20 * weighted_points + weighted_total) // (2 * weighted_total)
    result['scoring'].update({
        'version': PRIORITY_SCORING_VERSION,
        'rule': PRIORITY_SCORING_RULE,
        'weighted_total': weighted_total,
        'weighted_met': weighted_met,
        'weighted_unknown': weighted_unknown,
        'weighted_partial': weighted_partial,
        'weighted_no_evidence': weighted_no_evidence,
        'weighted_not_met': weighted_not_met,
        'priority_groups': layout,
        'condition_scores': _condition_scores(judgments, labels, weights),
    })
    return result
