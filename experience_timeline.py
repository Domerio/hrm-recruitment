"""Trace month-level employment dates to the original resume lines."""

from collections.abc import Sequence
from datetime import date
import re
import unicodedata


_WORK_SECTIONS = {'工作经历', '工作经验'}
_OTHER_SECTIONS = {
    '个人优势', '个人简介', '个人信息', '期望职位', '求职意向', '项目经历', '项目经验',
    '教育经历', '教育背景', '专业技能', '技能标签', '资格证书', '所获荣誉',
    '荣誉奖项', '获奖经历', '语言能力', '其他能力', '自我评价', '联系方式', '兴趣爱好',
    '培训经历', '培训经验', '进修经历',
}
_DATE = r'\d{4}(?:(?:年(?:\s*\d{1,2}\s*月?)?)|(?:[./-]\s*\d{1,2}\s*月?))?'
_RANGE = re.compile(
    r'(?<![\d.])(?P<start>' + _DATE + r')\s*[-–—−~～至]+\s*'
    r'(?P<end>至今|现在|目前|今|' + _DATE + r')(?![\d./年])'
)
_ENTITY = re.compile(r'公司|集团|股份|医院|研究院|研究所|实验室|事务所|银行|大学|学院')
_ROLE = re.compile(
    r'工程师|经理|主管|总监|负责人|研究员|顾问|实习生|设计师|分析师|医师|医生|'
    r'研发|开发|算法|图像|视觉|技术|部门|职位|岗位|engineer|developer|researcher|manager',
    re.IGNORECASE,
)
_PROSE_START = re.compile(
    r'^(?:[-•●▪]|\d+[.、)）]|负责|参与|完成|承担|主导|协助|使用|基于|通过|'
    r'期间|其中|例如|主要|工作内容|工作职责|职责|项目名称|项目时间|项目周期|'
    r'项目经历|项目经验|项目背景|项目内容|客户|业绩|内容|教育|毕业|学校)'
)
_DURATION = re.compile(r'^[\s()（）·|｜]*(?:共)?\d+年(?:\d+个?月)?[\s()（）·|｜]*$')


def _text(value):
    return unicodedata.normalize('NFKC', value).strip()


def _section(value):
    value = re.sub(r'\s+', '', value).strip('#*:：')
    return re.sub(r'[（(]\d+[）)]$', '', value)


def _header_fragment(value):
    if not value or len(value) > 180 or _RANGE.search(value) or _PROSE_START.match(value):
        return False
    if re.search(r'[。；;!！?？]', value):
        return False
    if re.search(r'(?:项目|课题|专项)$', value):
        return False
    if re.search(r'[:：]', value) and not re.match(r'^(?:公司|单位|机构|职位|岗位|部门)[:：]', value):
        return False
    return True


def _header_lines(lines, position, section_start, section_end, match):
    before = []
    for number in range(position - 1, max(section_start - 1, position - 5), -1):
        value = lines[number]
        if not value:
            continue
        if not _header_fragment(value):
            break
        before.append(number)
        if len(before) == 3:
            break
    before.reverse()
    outside = (lines[position][:match.start()] + ' ' + lines[position][match.end():]).strip(' |｜·')
    if _DURATION.fullmatch(outside) or re.fullmatch(r'(?:任职时间|工作时间|在职时间)[:：]?', outside):
        outside = ''
    if outside and not _header_fragment(outside):
        return None
    if _ENTITY.search(outside):
        before = []
    has_entity = bool(_ENTITY.search(outside) or any(_ENTITY.search(lines[number]) for number in before))
    after = []
    for number in range(position + 1, min(section_end, position + 3)):
        value = lines[number]
        if not value:
            continue
        if not _header_fragment(value) or not (_ENTITY.search(value) or _ROLE.search(value)):
            break
        if has_entity and _ENTITY.search(value):
            break
        after.append(number)
        has_entity = has_entity or bool(_ENTITY.search(value))
    title_lines = before + ([position] if outside else []) + after
    if not any(_ENTITY.search(outside if number == position else lines[number]) for number in title_lines):
        return None
    return title_lines


def _endpoint(value, as_of):
    value = re.sub(r'\s+', '', value)
    if value in {'今', '至今', '现在', '目前'}:
        return as_of.year, as_of.month, True, None
    match = re.fullmatch(r'(\d{4})(?:年(?:(\d{1,2})月?)?|[./-](\d{1,2})月?)?', value)
    if not match:
        return None, None, False, 'unsupported_date_format'
    year = int(match[1])
    if year < 1:
        return None, None, False, 'invalid_year'
    month = match[2] or match[3]
    if month is None:
        return year, None, False, 'missing_month'
    month = int(month)
    if not 1 <= month <= 12:
        return year, None, False, 'invalid_month'
    return year, month, False, None


def _month(year, month):
    return year * 12 + month - 1


def _union_months(intervals):
    total = 0
    start = end = None
    for next_start, next_end in sorted(intervals):
        if start is None:
            start, end = next_start, next_end
        elif next_start <= end:
            end = max(end, next_end)
        else:
            total += end - start
            start, end = next_start, next_end
    return total + (end - start if start is not None else 0)


def build_experience_timeline(lines: Sequence[str], as_of: date) -> dict:
    """Return dated work entries and their conservative, non-overlapping months.

    Line numbers are one-based and refer to lines without removing blanks.
    Uncertain dates have no duration and do not contribute to union_months.
    This function does not decide which work is relevant to a job requirement.
    """
    if isinstance(lines, str) or not all(isinstance(line, str) for line in lines):
        raise TypeError('lines must be a sequence of strings')
    if not isinstance(as_of, date):
        raise TypeError('as_of must be a date')
    values = [_text(line) for line in lines]
    entries, diagnostics, intervals = [], [], []
    work_start = None
    sections = []
    for number, value in enumerate(values):
        section = _section(value)
        if section in _WORK_SECTIONS or section in _OTHER_SECTIONS:
            if work_start is not None:
                sections.append((work_start, number))
            work_start = number + 1 if section in _WORK_SECTIONS else None
    if work_start is not None:
        sections.append((work_start, len(values)))

    as_of_month = _month(as_of.year, as_of.month)
    for section_start, section_end in sections:
        section_entries = []
        for position in range(section_start, section_end):
            value = values[position]
            matches = list(_RANGE.finditer(value))
            if not matches:
                if re.search(r'\d{4}.*(?:至今|现在|[-–—~～])', value):
                    diagnostics.append({'line':position + 1, 'reason':'unsupported_date_format'})
                continue
            if len(matches) != 1:
                diagnostics.append({'line':position + 1, 'reason':'ambiguous_multiple_ranges'})
                continue
            match = matches[0]
            title_lines = _header_lines(values, position, section_start, section_end, match)
            if title_lines is None:
                diagnostics.append({'line':position + 1, 'reason':'unconfirmed_employment_header'})
                continue
            start_year, start_month, _, start_issue = _endpoint(match['start'], as_of)
            end_year, end_month, present, end_issue = _endpoint(match['end'], as_of)
            reasons = []
            for side, problem in [('start', start_issue), ('end', end_issue)]:
                if problem:
                    reasons.append(side + '_' + problem)
            start = _month(start_year, start_month) if start_year is not None and start_month is not None else None
            end = _month(end_year, end_month) if end_year is not None and end_month is not None else None
            if any(year is not None and year > as_of.year for year in (start_year, end_year)) or any(
                    point is not None and point > as_of_month for point in (start, end)):
                reasons.append('future_date')
            if start is not None and end is not None and start > end:
                reasons.append('reversed_range')
            uncertain = bool(reasons)
            entry = {
                'start':f'{start_year:04d}-{start_month:02d}' if start is not None else None,
                'end':f'{end_year:04d}-{end_month:02d}' if end is not None else None,
                'duration_months':end - start if not uncertain else None,
                'date_line':position + 1,
                'context_start_line':min(title_lines + [position]) + 1,
                'context_end_line':section_end,
                'title_lines':[number + 1 for number in title_lines],
                'end_resolved_from_present':present,
                'uncertain':uncertain,
            }
            if uncertain:
                entry['uncertainty_reasons'] = reasons
                diagnostics.extend({'line':position + 1, 'reason':reason} for reason in reasons)
            else:
                intervals.append((start, end))
            section_entries.append(entry)
        for index, entry in enumerate(section_entries[:-1]):
            entry['context_end_line'] = section_entries[index + 1]['context_start_line'] - 1
        entries.extend(section_entries)
    return {'as_of':as_of.isoformat(), 'entries':entries, 'union_months':_union_months(intervals),
            'diagnostics':diagnostics}
