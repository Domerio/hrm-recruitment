"""Validate an explicitly configured undergraduate study-mode requirement.

This is a narrow contradiction/uncertainty check, not a degree classifier or a
scoring rule. Only the current copied resume's header and education records can
establish a degree. A quoted job requirement cannot establish eligibility.
"""

import re
import unicodedata

from resume_format import SECTIONS


NON_FULL_TIME_BACHELOR_ERROR = (
    '学历条件校验失败：简历明确为非全日制本科且未提供硕士及以上学位，必须判为不满足且不得给予部分分。'
)
UNVERIFIED_BACHELOR_ERROR = (
    '学历条件需核实：简历未明确本科为全日制且未提供硕士及以上学位，不可判为满足。'
)
_EDUCATION = {'教育经历', '教育背景', '教育信息', '学历信息'}
_HEADINGS = SECTIONS | _EDUCATION | {
    '个人信息', '基本信息', '联系方式', '兴趣爱好', '培训经验', '进修经历',
    '岗位要求', '职位要求', '任职要求', '招聘要求', '职位描述', '岗位描述', 'JD',
}
_DEGREE = re.compile(r'博士(?:研究生)?|硕士(?:研究生)?|研究生(?!院)|本科|学士|大专|专科|中专|高中')
_NOT_A_RECORD = re.compile(
    r'要求|须|必须|接受|允许|不限|及以上|以上学历|以下学历|优先|计划|打算|准备|报考|'
    r'希望|目标|招聘|JD|团队|培养|辅导|指导|招收|课程|培训|考研|考博', re.I
)
_UNFINISHED = re.compile(r'在读|未毕业|肄业|未(?:获得|取得)|尚未(?:获得|取得)|未拿到|未获')
_UNCERTAIN_MODE = re.compile(
    r'未说明|未注明|未标明|未标注|未标示|未明确|未提供|未填写|未知|不详|不确定|不清楚|无法确认|'
    r'待确认|待核实|待定|尚未说明|尚未注明|暂无'
)
_MODE_LABEL = re.compile(r'^(?:学习形式|学习方式|培养方式|教育形式)[:：]?')


def _compact(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))


def _applies(condition):
    """Require both halves of this particular configured policy explicitly."""
    value = _compact(condition)
    bachelor_full = re.search(
        r'(?:本科|学士)(?:学历)?(?:须|必须|要求)(?:为|是)?全日制', value
    )
    bachelor_reject = re.search(
        r'(?:不接受|不认可|不考虑)(?:本科(?:学历)?(?:为|是)?)?非全日制本科'
        r'|(?:不接受|不认可|不考虑)本科(?:学历)?(?:为|是)?非全日制'
        r'|本科(?:学历)?(?:不接受|不认可|不考虑)非全日制', value
    )
    graduate_allowed = re.search(
        r'(?:硕士|研究生)(?:及以上|以上)?(?:学历|学位)?(?:可|可以|允许)(?:为|是|接受)?非全日制'
        r'|(?:硕士|研究生)(?:及以上|以上)?(?:学历|学位)?接受非全日制', value
    )
    return bool((bachelor_full or bachelor_reject) and graduate_allowed)


def _heading(line):
    return re.sub(r'\(\d+\)$', '', _compact(line).strip('#*:：'))


def _mode(fragment):
    """Keep an absent mode distinct from contradictory or interrogative text."""
    non_full = re.search(r'非全日制|(?:不是|并非|不属于|不属)全日制|全日制[:：](?:否|不是)', fragment)
    affirmative = re.sub(r'非全日制|(?:不是|并非|不属于|不属)全日制|全日制[:：](?:否|不是)', '', fragment)
    full = '全日制' in affirmative
    if (non_full and full) or re.search(r'[?？]|是否|是不是|疑似|可能|或许', fragment):
        return 'ambiguous'
    if _UNCERTAIN_MODE.search(fragment):
        return 'unspecified'
    if non_full:
        return 'non_full'
    return 'full' if full else 'unspecified'


def _mode_line(line):
    value = _compact(line).strip('()（）')
    if _DEGREE.search(value) or len(value) > 50:
        return None
    labelled = bool(_MODE_LABEL.match(value))
    value = _MODE_LABEL.sub('', value)
    if labelled and (_UNCERTAIN_MODE.search(value) or value in {'未标注', '未标示', '无'}):
        return 'unspecified'
    if (labelled or re.fullmatch(r'[是否不非全日制待确认核实?？/、与或]+', value)) and '全日制' in value:
        return _mode(value)
    return None


def _record_degrees(line, header):
    value = _compact(line)
    if not value or len(value) > 220 or _NOT_A_RECORD.search(value):
        return []
    matches = list(_DEGREE.finditer(value))
    result = []
    for index, match in enumerate(matches):
        # Associate each mode only with its nearest degree fragment. A master's
        # non-full-time mode must never migrate to an earlier bachelor degree.
        start = matches[index - 1].end() if index else 0
        end = matches[index + 1].start() if index + 1 < len(matches) else len(value)
        before, after = value[start:match.start()], value[match.end():end]
        # Institution names such as "研究生院" or "合成本科大学" are not
        # qualifications. Never manufacture a degree quote from a school name.
        if re.match(r'大学|学院|院校|课程|教学|教材|教育', after):
            continue
        if header and before and not re.search(r'(?:学历|学位)[:：]$|[·•|｜/、,，;；]$|(?:非全日制|全日制)[(（]?$', before):
            continue
        fragment = before + match.group() + after
        if (_UNFINISHED.search(fragment) or
                re.search(r'(?:计划|报考|攻读|在读|没有|无|不是|并非|非)$', before)):
            continue
        if (re.match(r'^[?？]', after) or
                re.search(r'(?:是否|疑似|可能|待确认|待核实)[:：]?$', before)):
            continue
        if (re.match(r'^[（(]?(?:学历|学位|证书)?[:：]?(?:待核实|待确认|未知|不详|未明确|存疑)', after)
                and not re.search(r'学习形式|学习方式|培养方式|教育形式|全日制', after)):
            continue
        rank = (3 if re.search(r'博士', match.group()) else
                2 if re.search(r'硕士|研究生', match.group()) else
                1 if re.search(r'本科|学士', match.group()) else 0)
        result.append({'rank': rank, 'mode': _mode(fragment), 'evidence_quotes': [line]})
    return result


def _degrees(resume):
    lines = [line.strip() for line in resume.splitlines() if line.strip()]
    section, header_count, records, consumed_modes = '', 0, [], set()
    for index, line in enumerate(lines):
        heading = _heading(line)
        if heading in _HEADINGS:
            section = heading
            continue
        header = not section and header_count < 12
        if not section:
            header_count += 1
        if not header and section not in _EDUCATION:
            continue
        degrees = _record_degrees(line, header)
        # Copied education rows may place the study mode on the next line. Only
        # a standalone mode label is eligible, never text from another record.
        if degrees:
            neighbour = None
            if index + 1 < len(lines) and _mode_line(lines[index + 1]) is not None:
                neighbour = index + 1
            elif index > 0 and index - 1 not in consumed_modes and _mode_line(lines[index - 1]) is not None:
                neighbour = index - 1
            if neighbour is not None:
                neighbour_mode = _mode_line(lines[neighbour])
                consumed_modes.add(neighbour)
                for degree in degrees:
                    current = degree['mode']
                    if current == 'unspecified':
                        degree['mode'] = neighbour_mode
                    elif neighbour_mode != 'unspecified' and neighbour_mode != current:
                        degree['mode'] = 'ambiguous'
                    degree['evidence_quotes'].append(lines[neighbour])
        records.extend(degrees)
    return records


def education_policy_decision(condition, resume):
    """Return only a study-mode policy decision and verbatim resume evidence.

    ``eligible`` means this policy does not block the row, not that its major or
    any other requirement is satisfied. Unconfigured conditions are left alone
    with ``eligible`` and no quotes. An explicit bachelor's degree with no mode
    uses the user's configured default; no original full-time claim is invented.
    """
    def result(kind, records=()):
        quotes = list(dict.fromkeys(quote for record in records for quote in record['evidence_quotes']))
        return {'kind': kind, 'evidence_quotes': quotes}

    if not isinstance(condition, str) or not _applies(condition):
        return result('eligible')
    if not isinstance(resume, str) or not resume.strip() or len(resume) > 30000:
        return result('unverified')
    degrees = _degrees(resume)
    higher = [record for record in degrees if record['rank'] >= 2]
    if higher:
        highest = max(record['rank'] for record in higher)
        return result('eligible', [record for record in higher if record['rank'] == highest])
    bachelors = [record for record in degrees if record['rank'] == 1]
    modes = {record['mode'] for record in bachelors}
    if not bachelors:
        return result('unverified')
    if 'ambiguous' in modes or {'full', 'non_full'} <= modes:
        return result('unverified', bachelors)
    if 'non_full' in modes:
        return result('non_full_time_bachelor', [record for record in bachelors if record['mode'] == 'non_full'])
    if 'full' in modes:
        return result('eligible', [record for record in bachelors if record['mode'] == 'full'])
    return result('bachelor_default_full_time', bachelors)


def verify_education_policy(check, resume):
    """Return a static repair error for an unsupported education judgment.

    ``check['condition']`` must be the server's configured condition text, not a
    model's replacement. No input is mutated and no degree/score is fabricated.
    The caller adds its existing condition path when reporting a validation error.
    """
    if not isinstance(check, dict):
        return None
    status = check.get('status')
    decision = education_policy_decision(check.get('condition'), resume)
    if decision['kind'] == 'non_full_time_bachelor':
        return NON_FULL_TIME_BACHELOR_ERROR if status != '不满足' else None
    return UNVERIFIED_BACHELOR_ERROR if decision['kind'] == 'unverified' and status == '满足' else None
