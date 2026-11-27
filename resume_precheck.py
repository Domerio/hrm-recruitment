"""Conservative, evidence-bound contradictions to explicitly selected hard rules.

Absence of a skill, a degree record, or a dated job is never a rejection. Only
an explicit highest qualification or exact total working duration can establish
an upper bound. The model handles every unsupported or ambiguous condition.
"""
from datetime import date
from decimal import Decimal
import re
import unicodedata

from education_policy import education_policy_decision, _section_line
from experience_timeline import build_experience_timeline
from record_editing import requirement_lines
from resume_format import display_lines, resume_has_folded_controls


PRECHECK_VERSION = 'hard-rules-v1'
_DEGREES = {'初中': 0, '高中': 0, '中专': 0, '大专': 1, '专科': 1,
            '本科': 2, '学士': 2, '硕士': 3, '硕士研究生': 3,
            '研究生': 3, '博士': 4, '博士研究生': 4}
_DEGREE_WORD = '|'.join(sorted(_DEGREES, key=len, reverse=True))
_DEGREE = re.compile(_DEGREE_WORD)
_MIN_DEGREE = re.compile(
    rf'(?P<degree>{_DEGREE_WORD})(?:学历|学位)?(?:及以上|或以上|以上)(?:学历|学位)?'
    rf'|(?:至少|最低)(?:为|是|要求)?(?P<prefix>{_DEGREE_WORD})(?:学历|学位)?')
_HIGHEST = re.compile(
    rf'^(?:(?:本人|个人)的?)?最高(?:学历|学位)\s*[:：为是]?\s*'
    rf'(?:全日制|非全日制)?\s*(?P<degree>{_DEGREE_WORD})(?!大学|学院)')
_NUM = r'(?:\d{1,2}(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,3})'
_MIN_YEARS = re.compile(
    rf'(?:至少|不少于|不低于|最低|最少)\s*(?P<prefix>{_NUM})\s*年'
    rf'|(?<![\d.\-~～])(?P<suffix>{_NUM})\s*年\s*(?:及以上|或以上|以上)')
_TOTAL_LABEL = (
    r'(?:总(?:计|共)?(?:工作|从业)(?:经验|经历|年限|时间)'
    r'|(?:工作|从业)(?:经验|经历|年限|时间)(?:总计|累计|合计|共计)'
    r'|(?:累计|合计|总计|共计)(?:工作|从业)(?:经验|经历|年限|时间)?)')
_TOTAL = re.compile(
    rf'^(?:(?:本人|个人)的?)?{_TOTAL_LABEL}\s*[:：为是]?\s*(?:仅|只有)?'
    rf'(?:(?P<years>{_NUM})\s*年(?:\s*(?P<extra>{_NUM})\s*个?月)?'
    rf'|(?P<months>{_NUM})\s*个?月)(?=\s*(?:$|[，,。;；]))')
_DURATION_CLAIM = re.compile(
    rf'(?<![\d.])(?P<years>{_NUM})\s*年[^\d\n，,。;；]{{0,36}}'
    r'(?:经验|经历|开发|工作|从业|研究|学习)')
_PROTECTED = re.compile(
    r'年龄|岁|性别|男性|女性|男士|女士|民族|种族|籍贯|户籍|户口|婚姻|已婚|未婚|'
    r'生育|怀孕|宗教|身高|体重|残疾|健康|政治面貌')
_RELAXED = re.compile(r'优先|加分|不限|不限制|放宽|可替代|可代替|等同|同等|'
                      r'或(?:具备|具有|有|大专|专科|中专|高中|\d|[一二三四五六七八九十])')
_NOT_SELF = re.compile(r'招聘|任职|岗位|要求|候选人|模板|示例|样例|例如|比如|假设|如果|'
                       r'团队|成员|下属|同事|导师|指导|培养|客户|面试')
_UNCERTAIN = re.compile(r'[?？]|是否|疑似|可能|待确认|待核实|不详|未知|不确定|未确认|'
                        r'计划|准备|报考|攻读|在读|未毕业|肄业')
_NON_EXACT = re.compile(r'以上|至少|不少于|超过|多于|余年|多年|左右|大约|约|近|不含|'
                        r'不包括|不计|仅统计|其中|分别|包括|截至\d|[+＋~～]')
_EDUCATION_CONTEXT = {'', '个人信息', '基本信息', '教育经历', '教育背景', '教育信息', '学历信息'}
_WORK_CONTEXT = {'', '个人信息', '基本信息', '个人优势', '个人简介', '自我评价', '工作经历', '工作经验'}


def _norm(value):
    return unicodedata.normalize('NFKC', value).strip()


def _number(value):
    if value is None:
        return Decimal(0)
    if re.fullmatch(r'\d+(?:\.\d+)?', value):
        return Decimal(value)
    digits = dict(zip('零〇一二两三四五六七八九', [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9]))
    if value in digits:
        return Decimal(digits[value])
    if value.count('十') == 1:
        before, after = value.split('十')
        if (not before or before in digits) and (not after or after in digits):
            return Decimal((digits[before] if before else 1) * 10 + (digits[after] if after else 0))
    return None


def _context_rows(lines):
    # Share the education guard's section boundaries, including inline canvas
    # headings and mixed sections. Quoted job requirements are not personal facts.
    section, header_count = '', 0
    rows = []
    for number, original in enumerate(lines, 1):
        heading, content = _section_line(original)
        if heading is not None:
            section = heading
            if not content:
                continue
        if not section:
            header_count += 1
        rows.append({'line': number, 'quote': original, 'text': _norm(content),
                     'section': section if section or header_count <= 12 else 'unknown'})
    return rows


def _highest_degree(rows):
    facts = []
    context = [row for row in rows if row['section'] in _EDUCATION_CONTEXT]
    for row in context:
        text = row['text']
        match = _HIGHEST.match(text)
        if match and not _NOT_SELF.search(text) and not _UNCERTAIN.search(text) and not _NON_EXACT.search(text):
            facts.append({**row, 'rank': _DEGREES[match['degree']], 'degree': match['degree']})
    if not facts or len({fact['rank'] for fact in facts}) != 1:
        return None
    highest = facts[0]['rank']
    # Even an unfinished or uncertain higher record warrants model review.
    # Never use a missing degree entry as proof of a lower maximum.
    if any(_DEGREES[match.group()] > highest
           for row in context for match in _DEGREE.finditer(row['text'])):
        return None
    return facts


_HEADER_NAME = re.compile(r'^(?:[\u3400-\u9fff·]{1,16}(?:\*{1,4}|先生|女士)|[\u3400-\u9fff·]{2,8})$')
_ACTIVITY = r'(?:刚刚|今日|今天|本周|本月|近期|\d+(?:秒|分钟|小时|天|日|周|月)(?:内|前)?)活跃|已收藏|在线|首页推荐'
_META_TOKEN = re.compile(
    rf'(?P<age>\d{{1,3}}岁)|(?P<degree>{_DEGREE_WORD})'
    rf'|(?P<years>{_NUM})年(?P<bound>以上|以下|\+)?'
    r'|(?P<state>离职(?:[-—–]?(?:随时到岗|月内到岗))?'
    r'|在职(?:[-—–]?(?:考虑机会|暂不考虑(?:机会)?|月内到岗))?)'
    rf'|(?:{_ACTIVITY})|[|·•,，/—–-]')


def _header_total(rows):
    """Read the total-years token only in a complete BOSS identity metadata block.

    Age is a layout marker here, never a qualification, numerical threshold or
    rejection feature. No identity or demographic value enters a rule decision.
    """
    header = [row for row in rows if row['section'] == '']
    for position, row in enumerate(header[:4]):
        name = re.sub(rf'(?:{_ACTIVITY})+$', '', row['text']).replace('＊', '*').strip()
        if not _HEADER_NAME.fullmatch(name):
            continue
        tokens = []
        for meta in header[position+1:position+7]:
            value = re.sub(r'\s+', '', meta['text'])
            matches = list(_META_TOKEN.finditer(value))
            if not matches or ''.join(match.group() for match in matches) != value:
                break
            tokens.extend((match, meta) for match in matches)
        fields = {key: [(match, meta) for match, meta in tokens if match[key]]
                  for key in ('age', 'degree', 'years', 'state')}
        if any(len(field) != 1 for field in fields.values()):
            continue
        match, evidence = fields['years'][0]
        years = _number(match['years'])
        if years is None or not 0 <= years <= 60:
            continue
        return [{**evidence, 'months': years * 12, 'header': True, 'exact': not bool(match['bound'])}]
    return []


def _total_experience(rows, lines, evaluation_date):

    facts = []
    context = [row for row in rows if row['section'] in _WORK_CONTEXT]
    for row in context:
        text = row['text']
        if _NOT_SELF.search(text) or _UNCERTAIN.search(text) or _NON_EXACT.search(text):
            continue
        match = _TOTAL.match(text)
        if not match:
            continue
        years, extra, months = (_number(match[key]) for key in ('years', 'extra', 'months'))
        if any(value is None for value in (years, extra, months)) or extra >= 12:
            continue
        duration = years * 12 + extra + months
        if 0 <= duration <= 60 * 12:
            facts.append({**row, 'months': duration})
    header = _header_total(rows)
    if any(not fact['exact'] for fact in header):
        return None
    facts.extend(header)
    if not facts or len({fact['months'] for fact in facts}) != 1:
        return None
    total = facts[0]['months']
    # Longer explicitly stated project/research experience may be transferable.
    # It can block a rejection, but never establishes a total-work upper bound.
    conflict_context = _WORK_CONTEXT | {'项目经历', '项目经验', '专业技能', '其他能力',
                                        '教育经历', '教育背景', '教育信息'}
    for row in rows:
        if row['section'] not in conflict_context:
            continue
        for match in _DURATION_CLAIM.finditer(row['text']):
            value = _number(match['years'])
            if value is not None and value * 12 > total:
                return None
    # Dates are a contradiction guard only. A short/absent timeline never
    # establishes an upper bound or substitutes for the explicit total.
    if evaluation_date is None:
        if any(re.search(r'(?<!\d)(?:19|20)\d{2}(?!\d)', row['text'])
               for row in context if row['section'] in {'工作经历', '工作经验'}):
            return None
    elif not isinstance(evaluation_date, date):
        return None
    else:
        timeline = build_experience_timeline(lines, evaluation_date)
        if timeline['diagnostics'] or timeline['union_months'] > total:
            return None
    return facts


def _evidence_rows(facts):
    rows = {fact['line']: fact['quote'] for fact in facts}
    return sorted(rows), [rows[number] for number in sorted(rows)]


def precheck_resume(job, resume, *, lines=None, evaluation_date=None):
    """Return proven hard-condition failures, or continue to normal evaluation.

    Evidence uses the caller's display-line numbering when supplied. No scores,
    demographic rules, model calls, persistence, or logging occur in this module.
    """
    result = {'version': PRECHECK_VERSION, 'rejected': False, 'checks': []}
    if not isinstance(job, dict) or not isinstance(resume, str) or not resume.strip() or len(resume) > 30000:
        return result
    if not isinstance(job.get('must_have', ''), str) or resume_has_folded_controls(resume):
        return result
    required = requirement_lines(job.get('must_have', ''), 100, max_line=12000)
    if not required:
        return result
    if lines is None:
        lines = display_lines(resume)
    elif (not isinstance(lines, (list, tuple)) or not all(isinstance(line, str) for line in lines)
          or any(line.strip() and line.strip() not in resume for line in lines)):
        return result
    rows = _context_rows(lines)
    highest = _highest_degree(rows)
    total = _total_experience(rows, lines, evaluation_date)

    def reject(index, condition, rule, facts, reasoning):
        numbers, quotes = _evidence_rows(facts)
        if numbers:
            result['checks'].append({'requirement_id': index, 'condition': condition, 'rule_id': rule,
                                     'status': '不满足', 'basis': 'explicit',
                                     'evidence_lines': numbers, 'evidence_quotes': quotes,
                                     'reasoning': reasoning})

    for index, condition in enumerate(required, 1):
        normalized = _norm(condition)
        if _PROTECTED.search(normalized) or _RELAXED.search(normalized):
            continue
        minima = [(match['degree'] or match['prefix']) for match in _MIN_DEGREE.finditer(normalized)]
        if highest and minima:
            minimum = min(minima, key=_DEGREES.__getitem__)
            if highest[0]['rank'] < _DEGREES[minimum]:
                reject(index, condition, 'highest_degree_below_minimum', highest,
                       f"原文明确最高学历为{highest[0]['degree']}，低于该硬性条件要求的{minimum}及以上。")
                continue
        if highest and highest[0]['rank'] == _DEGREES['本科']:
            decision = education_policy_decision(condition, '\n'.join(lines))
            if decision['kind'] == 'non_full_time_bachelor':
                quoted = [row for row in rows if row['section'] in _EDUCATION_CONTEXT
                          and row['quote'].strip() in decision['evidence_quotes']]
                if quoted:
                    reject(index, condition, 'highest_bachelor_non_full_time', highest + quoted,
                           '原文明确最高学历为本科，且该本科为非全日制，违反当前岗位明确的本科全日制硬性要求。')
                    continue
        if total and re.search(r'(?:工作|从业|开发|行业|业务|销售|售前|BD)[^。;；\n]{0,80}(?:经验|经历|年限)', normalized, re.I):
            durations = [_number(match['prefix'] or match['suffix']) for match in _MIN_YEARS.finditer(normalized)]
            durations = [value * 12 for value in durations if value is not None and 0 < value <= 60]
            if durations and total[0]['months'] < min(durations):
                declared = format(total[0]['months'].normalize(), 'f')
                minimum = format(min(durations).normalize(), 'f')
                origin = '平台页首明确展示的总工作年限' if any(fact.get('header') for fact in total) else '原文明示总工作年限'
                reject(index, condition, 'total_experience_below_minimum', total,
                       f'{origin}为{declared}个月，低于该硬性条件要求的至少{minimum}个月。')
    result['rejected'] = bool(result['checks'])
    return result
