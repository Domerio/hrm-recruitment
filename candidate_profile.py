"""Extract explicit profile fields from locally copied resumes, without a model.

Only candidate-supplied text is used. Work and project sections are deliberately
separate: a customer's name in a project is never promoted to an employer.
"""
from datetime import date
import re
import unicodedata

from experience_timeline import build_experience_timeline
from resume_format import (DATE_RANGE, SECTIONS, ResumeHTML,
                           is_resume_tag, resume_entry)


FIELDS = ('company', 'title', 'city', 'education', 'skills')
LIMITS = {'company': 200, 'title': 200, 'city': 100, 'education': 200, 'skills': 4000}
_WORK = {'工作经历', '工作经验'}
_EDUCATION = {'教育经历', '教育背景'}
_INTENT = {'期望职位', '求职意向'}
_SKILLS = {'技能标签', '专业技能'}
_HEADINGS = SECTIONS | {'个人信息', '基本信息', '联系方式', '兴趣爱好', '培训经验', '进修经历'}
_ENTITY_END = re.compile(r'有限公司|有限责任公司|股份公司|公司|集团|研究院|研究所|实验室|事务所|工作室|医院|银行|大学|学院')
_ROLE = re.compile(r'工程师|经理|主管|总监|负责人|研究员|顾问|实习生|设计师|分析师|医师|医生|'
                   r'专员|销售|采购|开发|研发|算法|图像|视觉|技术|软件|硬件|机械|电气|'
                   r'engineer|developer|researcher|manager|[Cc](?:\+\+|#|/[Cc]\+\+)|Python', re.I)
_PROSE = re.compile(r'^(?:[-•●▪]|\d+[.、)）]|负责|参与|完成|承担|主导|协助|使用|基于|通过|期间|其中|'
                    r'例如|主要|工作内容|工作职责|职责|项目名称|项目时间|项目周期|项目背景|项目内容|客户|业绩|内容)')
_DEGREE = re.compile(r'博士(?:研究生|后)?|硕士(?:研究生)?|研究生|本科|学士|大专|专科|中专|职高|高中|初中')
_SCHOOL_MODE = re.compile(r'^\s*(?:[·•/、|｜]\s*)?(?:非全日制|全日制|在读|成人教育|自考|函授)')
_SALARY = re.compile(r'^(?:薪资)?面议$|\d+(?:\.\d+)?\s*[-~～至]?\s*\d*(?:\.\d+)?\s*[kKwW千万元]')
_LOCATION_LABEL = re.compile(r'^(?:当前城市|现居城市|现居地|现居住地|所在城市|所在地|居住地|期望城市|意向城市)\s*[:：]\s*(.+)$')
_SEPARATORS = re.compile(r'\s*[·•|｜;；]\s*|\t+| {2,}')


def _norm(value):
    return unicodedata.normalize('NFKC', value).strip()


def _heading(value):
    text = re.sub(r'\s+', '', _norm(value)).strip('#*:：')
    return re.sub(r'\(\d+\)$', '', text)


def _lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


def _section_blocks(lines):
    sections, section, begin = [], '', 0
    for number, line in enumerate(lines):
        heading = _heading(line)
        if heading in _HEADINGS:
            if section:
                sections.append((section, begin, number))
            section, begin = heading, number + 1
    if section:
        sections.append((section, begin, len(lines)))
    return sections


def _fragment(value):
    value = DATE_RANGE.sub('', value).strip(' \t|｜·•*')
    return value if value and len(value) <= 200 and not _PROSE.match(_norm(value)) and not re.search(r'[。；;!！?？]', value) else ''


def _company_and_tail(value):
    """Split a compact employer/title row at an actual institution suffix."""
    value = _fragment(value)
    if not value:
        return '', ''
    explicit = re.match(r'^(?:公司|单位|机构|最近公司|当前公司)\s*[:：]\s*(.+)$', value)
    value = explicit[1] if explicit else value
    # An engineering title followed by a research-institute department is a role.
    first_entity = _ENTITY_END.search(value)
    first_role = _ROLE.search(value)
    if not explicit and first_role and first_entity and first_role.start() < first_entity.start():
        if re.search(r'工程师|经理|主管|总监|负责人|研究员|顾问|专员', value[:first_entity.start()]):
            return '', ''
    for match in _ENTITY_END.finditer(value):
        tail = value[match.end():].strip(' \t|｜·•*')
        # A university can be followed by the rest of its institute's full name.
        if not tail or _ROLE.search(tail) or re.match(r'^\s*[|｜·•\t]', value[match.end():]):
            company = value[:match.end()].strip(' \t|｜·•*')
            if company and len(company) <= LIMITS['company']:
                return company, tail
    return '', ''


def _header_fields(fragments):
    company, title, company_evidence, title_evidence = '', '', '', ''
    for raw in fragments:
        fragment = _fragment(raw)
        if not fragment:
            continue
        employer, tail = _company_and_tail(fragment)
        if employer and not company:
            company, company_evidence = employer, raw
            if tail and _ROLE.search(tail):
                title, title_evidence = tail, raw
            continue
        if company and not title:
            role = re.sub(r'^(?:职位|岗位|最近职位|当前职位)\s*[:：]\s*', '', fragment)
            if _ROLE.search(role) and not (employer and not re.search(r'工程师|经理|负责人|总监|主管|专员', role)):
                title, title_evidence = role, raw
    result = {}
    if company:
        result['company'] = (company, company_evidence)
    if title and len(title) <= LIMITS['title']:
        result['title'] = (title, title_evidence)
    return result


def _work_profile(lines, sections):
    # A fixed far-future boundary gives "至今" a stable sort value. Duration and
    # suitability are not inferred here; those remain the evaluator's concern.
    timeline = build_experience_timeline(lines, date(9999, 12, 31))
    entries = []
    for entry in timeline['entries']:
        fragments = [lines[number - 1] for number in entry['title_lines']]
        fields = _header_fields(fragments)
        if not fields.get('company'):
            continue
        raw_date = lines[entry['date_line'] - 1]
        years = re.findall(r'(?<!\d)(\d{4})(?!\d)', _norm(raw_date))
        start = entry['start'] or (years[0] if years else '')
        end = entry['end'] or (years[-1] if len(years) > 1 else '')
        entries.append(((entry['end_resolved_from_present'], end, start, -entry['date_line']), fields))
    if entries:
        return max(entries, key=lambda item: item[0])[1]
    # Some manually pasted resumes omit dates. Only the first header of an
    # explicit work section is eligible, never an organization from prose.
    for section, start, end in sections:
        if section in _WORK:
            return _header_fields(lines[start:min(start + 3, end)])
    return {}


def _valid_location(value):
    value = value.strip(' \t|｜·•:：')
    if not value or len(value) > 80 or _ROLE.search(value) or _ENTITY_END.search(value) or _SALARY.search(value):
        return ''
    if re.search(r'\d|[。；;:：!?！？]', value) or value in {'行业不限', '不限行业', '不限', '面议'}:
        return ''
    # Named Chinese/English places and their explicit lists are accepted;
    # unrestricted industry/prose values are not treated as geographic facts.
    if not re.fullmatch(r'[\u3400-\u9fffA-Za-z ()（）/、,，\-·]+', value):
        return ''
    if re.search(r'行业|设备|软件|硬件|自动化|人工智能|互联网|大数据|消费电子', value):
        return ''
    return value


def _city(lines, sections):
    header_end = min((start - 1 for _, start, _ in sections), default=len(lines))
    for line in lines[:header_end]:
        match = _LOCATION_LABEL.match(line)
        if match:
            value = _valid_location(match[1])
            if value:
                return value, line
    for section, start, end in sections:
        if section not in _INTENT or start >= end:
            continue
        line = lines[start]
        match = _LOCATION_LABEL.match(line)
        candidates = [match[1]] if match else _SEPARATORS.split(line)
        value = _valid_location(candidates[0])
        if value:
            return value, line
    return None


def _degree_rank(value):
    for name, rank in [('博士', 9), ('硕士', 8), ('研究生', 7), ('本科', 6), ('学士', 6),
                       ('大专', 5), ('专科', 5), ('中专', 4), ('职高', 4), ('高中', 3), ('初中', 2)]:
        if name in value:
            return rank
    return 0


def _education(lines, sections):
    header_end = min((start - 1 for _, start, _ in sections), default=min(len(lines), 12))
    indices = list(range(min(header_end, 12)))
    for section, start, end in sections:
        if section in _EDUCATION:
            indices.extend(range(start, end))
    candidates = []
    for index in indices:
        line = lines[index]
        if len(line) > 200 or re.search(r'[。;；!！?？]', line) or _PROSE.match(_norm(line)):
            continue
        for match in _DEGREE.finditer(line):
            before, after = line[:match.start()], line[match.end():]
            # Exclude wish-list prose such as "希望本科以上团队".
            if index < header_end and before and not re.search(r'学历\s*[:：]\s*$|[·•|｜\t]\s*$', before):
                continue
            if re.match(r'^以上|^以下|^及以上|^优先|^要求', after):
                continue
            mode = _SCHOOL_MODE.match(after)
            value = match.group() + (mode.group() if mode else '')
            candidates.append(((_degree_rank(value), bool(mode), -index), (value.strip(), line)))
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def _skill_tags(lines, sections):
    tags, seen, first_evidence = [], set(), ''
    work_headers = set()
    for entry in build_experience_timeline(lines, date(9999, 12, 31))['entries']:
        numbers = [number - 1 for number in entry['title_lines']]
        fields = _header_fields([lines[number] for number in numbers])
        evidence = {item[1] for item in fields.values()}
        selected = [number for number in numbers if lines[number] in evidence]
        if selected:
            selected.append(entry['date_line'] - 1)
            work_headers.update(range(min(selected), max(selected) + 1))
    for section, start, end in sections:
        if section not in _WORK | {'项目经历', '项目经验'} | _SKILLS:
            continue
        index = start
        while index < end:
            # Dated employment/project headers, including compact horizontal
            # rows, are not skills even when they contain short role names.
            entry = resume_entry(lines, index, section)
            if entry:
                index += len(entry[0]) + 1
                continue
            if index in work_headers or DATE_RANGE.search(lines[index]):
                index += 1
                continue
            begin = index
            while (index < end and index not in work_headers and is_resume_tag(lines[index])
                   and not resume_entry(lines, index, section)):
                if _ENTITY_END.search(lines[index]) or _ROLE.fullmatch(lines[index]) and lines[index] not in {'图像', '视觉', '算法', '图像算法', 'C++', 'C#', 'C/C++', 'Python'}:
                    break
                index += 1
            run = lines[begin:index]
            boundary = index == end or resume_entry(lines, index, section) or bool(DATE_RANGE.search(lines[index])) or bool(_company_and_tail(lines[index])[0])
            if run and (section in _SKILLS or len(run) >= 2 and boundary):
                for tag in run:
                    key = _norm(tag).casefold()
                    if key not in seen and len('\n'.join(tags + [tag])) <= LIMITS['skills']:
                        seen.add(key)
                        tags.append(tag)
                if not first_evidence:
                    first_evidence = run[0]
            index = max(index, begin + 1)
    return ('\n'.join(tags), first_evidence) if tags else None


def extract_candidate_profile_with_sources(resume, resume_html=''):
    """Return explicit fields and short original-text evidence for each.

    ``skills`` evidence is an excerpt from the first explicit tag group. Values
    can aggregate further explicit tag groups. Empty/invalid/oversize inputs
    return empty dictionaries. Rich text is a fallback only when text is empty.
    """
    empty = {'profile': {}, 'profile_sources': {}}
    if not isinstance(resume, str) or len(resume) > 30000:
        return empty
    if not resume.strip() and isinstance(resume_html, str) and len(resume_html) <= 300000:
        try:
            parser = ResumeHTML()
            parser.feed(resume_html)
            parser.close()
            resume = ''.join(parser.text)
        except (ValueError, RecursionError):
            return empty
    if not resume.strip() or len(resume) > 30000:
        return empty
    lines = _lines(resume)
    sections = _section_blocks(lines)
    fields = _work_profile(lines, sections)
    for field, result in [('city', _city(lines, sections)), ('education', _education(lines, sections)),
                          ('skills', _skill_tags(lines, sections))]:
        if result:
            fields[field] = result
    profile, sources = {}, {}
    for field in FIELDS:
        if field in fields and fields[field][0] and len(fields[field][0]) <= LIMITS[field]:
            value, evidence = fields[field]
            profile[field] = value
            sources[field] = {'source': 'resume', 'evidence': evidence[:1000]}
    return {'profile': profile, 'profile_sources': sources}


def extract_candidate_profile(resume, resume_html=''):
    return extract_candidate_profile_with_sources(resume, resume_html)['profile']
