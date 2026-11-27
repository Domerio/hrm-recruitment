"""Persist platform search preferences separately from AI evaluation requirements."""
import json
import unicodedata


SEARCH_DEFAULTS = {
    'enabled': False,
    'salary': '',
    'activity': '',
    'job_hopping': '',
    'job_status': '',
    'position_requirements': '',
    'major': '',
    'sort': '',
    'exclude_viewed_14d': None,
    'exclude_contacted_30d': None,
    'recommend_activity': '',
    'recommend_job_status': '',
    'recommend_salary': '',
    'recommend_gender': '',
    'recommend_school': '',
    'recommend_education': '',
    'recommend_experience': '',
}
SORT_OPTIONS = {'', '综合排序', '活跃优先', '匹配度优先'}


def normalize_search_conditions(value):
    """Validate the small, explicit schema; omitted fields use neutral defaults."""
    if not isinstance(value, dict):
        raise ValueError('平台查询条件必须是对象')
    if set(value) - SEARCH_DEFAULTS.keys():
        raise ValueError('平台查询条件包含不支持的字段')
    result = dict(SEARCH_DEFAULTS)
    for key, item in value.items():
        if key == 'enabled':
            if type(item) is not bool:
                raise ValueError('平台查询条件 enabled 必须是布尔值')
        elif key in ('exclude_viewed_14d', 'exclude_contacted_30d'):
            if item is not None and type(item) is not bool:
                raise ValueError(f'平台查询条件 {key} 必须是布尔值或空值')
        else:
            if not isinstance(item, str) or len(item) > 80:
                raise ValueError(f'平台查询条件 {key} 必须是 80 字以内的文本')
            if any(unicodedata.category(char) in {'Cc', 'Cf', 'Cs', 'Zl', 'Zp'} for char in item):
                raise ValueError(f'平台查询条件 {key} 不能包含控制字符')
            item = item.strip()
            if key == 'sort' and item not in SORT_OPTIONS:
                raise ValueError('平台查询排序必须是综合排序、活跃优先、匹配度优先或空值')
        result[key] = item
    return result


def search_conditions_record(db, job_id):
    row = db.execute('SELECT conditions_json FROM job_search_conditions WHERE job_id=?', (job_id,)).fetchone()
    return normalize_search_conditions(json.loads(row[0])) if row else dict(SEARCH_DEFAULTS)


def save_search_conditions(db, job_id, value):
    conditions = normalize_search_conditions(value)
    db.execute('''INSERT INTO job_search_conditions(job_id,conditions_json) VALUES(?,?)
        ON CONFLICT(job_id) DO UPDATE SET conditions_json=excluded.conditions_json''',
        (job_id, json.dumps(conditions, ensure_ascii=False)))
