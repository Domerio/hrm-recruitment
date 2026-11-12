"""Recalculate complete saved judgments without requesting another model answer."""
from copy import deepcopy

from evaluation_scoring import calculate_score, SCORING_VERSION, PRIORITY_SCORING_VERSION


LEGACY_SCORING_VERSIONS = ('equal-weight-v1', 'priority-weight-v1')
ZERO_SCORING_VERSIONS = ('equal-weight-v2', 'priority-weight-v2')
PARTIAL_SCORING_VERSIONS = ('equal-weight-v3', 'priority-weight-v3')


def score_category(score, must_have_status):
    category = '推荐' if score >= 75 else '待确认' if score >= 50 else '低匹配'
    if must_have_status == 'not_met':
        return '低匹配'
    if must_have_status == 'unknown' and category == '推荐':
        return '待确认'
    return category


def rescore_saved_result(result, adjusted_at):
    """Only known, complete scoring snapshots qualify for automatic migration."""
    if not isinstance(result, dict) or not isinstance(result.get('scoring'), dict):
        raise ValueError('缺少完整评分快照')
    previous = result['scoring']
    if previous.get('version') not in LEGACY_SCORING_VERSIONS + ZERO_SCORING_VERSIONS + PARTIAL_SCORING_VERSIONS:
        raise ValueError('旧评分版本无法安全重算')
    checks, required = result.get('checks'), result.get('required_checks')
    if not isinstance(checks, list) or not checks or not isinstance(required, list):
        raise ValueError('缺少完整条件判断')
    for row in checks + required:
        if not isinstance(row, dict):
            raise ValueError('条件判断格式无效')
        if row.get('status') != '信息不足':
            evidence = row.get('evidence')
            quotes = row.get('evidence_quotes')
            if not (isinstance(evidence, str) and evidence.strip() or
                    isinstance(quotes, list) and quotes and all(isinstance(q, str) and q.strip() for q in quotes)):
                raise ValueError('有分判断缺少已保存的原文依据')
        if row.get('basis') == 'unknown' and row.get('status') != '信息不足':
            raise ValueError('条件状态与证据来源冲突')
        if row.get('basis') == 'inferred' and (not isinstance(row.get('reasoning'), str) or not row['reasoning'].strip()):
            raise ValueError('项目推断缺少已保存的说明')

    layout = None
    if previous['version'].startswith('priority-weight-'):
        groups = previous.get('priority_groups')
        if not isinstance(groups, list) or not groups:
            raise ValueError('缺少原优先级快照')
        layout = []
        for index, group in enumerate(groups):
            if (not isinstance(group, dict) or type(group.get('priority')) is not int or group['priority'] != index + 1 or
                    type(group.get('weight')) is not int or group['weight'] != len(groups) - index):
                raise ValueError('原优先级权重不完整')
            layout.append(group.get('conditions'))
    computed = calculate_score(checks, required, priority_groups=layout)
    counts = ['total', 'met', 'unknown', 'not_met']
    if layout is not None:
        counts += ['weighted_total', 'weighted_met', 'weighted_unknown', 'weighted_not_met']
    for key in counts:
        if type(previous.get(key)) is not int or previous[key] != computed['scoring'][key]:
            raise ValueError('旧条件或权重计数不完整')
    if type(result.get('score')) is not int or not 0 <= result['score'] <= 100:
        raise ValueError('旧分数格式无效')
    migrated = deepcopy(result)
    statuses = [row['status'] for row in required]
    must_have = ('not_configured' if not statuses else 'not_met' if '不满足' in statuses
                 else 'unknown' if '信息不足' in statuses else 'met')
    migrated.update(computed)
    migrated['must_have_status'] = must_have
    migrated['category'] = score_category(computed['score'], must_have)
    migrated.pop('scoring_obsolete', None)
    migrated['scoring_adjustment_v4'] = {
        'reason':'graded_evidence_v4', 'previous_score':result['score'],
        'previous_category':result.get('category'), 'previous_scoring':deepcopy(previous),
        'adjusted_at':adjusted_at,
    }
    return migrated


def current_scoring(result):
    return (isinstance(result, dict) and not result.get('scoring_obsolete') and
            isinstance(result.get('scoring'), dict) and
            result['scoring'].get('version') in (SCORING_VERSION, PRIORITY_SCORING_VERSION))
