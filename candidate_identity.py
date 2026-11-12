"""Conservative identities from visible cards and copied resumes."""

import re
import unicodedata
from difflib import SequenceMatcher

from resume_format import clean_resume_display_text


_SECTIONS = re.compile(r'^(?:个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|专业技能|资格证书)')
_ACTIVITY = re.compile(r'(?:刚刚|今日|今天|昨日|本周|本月|近期)活跃|\d+(?:分钟|小时|天|周|月)(?:内|前)?活跃')
_FIRST_VIEW = re.compile(r'近14天你首次看到该牛人(?:[，,]赶紧联系ta吧)?')
_BADGES = re.compile(r'热搜|已收藏|已查看')
_CARD_ACTIONS = re.compile(r'联系(?:ta|他|她)|立即沟通|打招呼|查看详情')
_ANCHOR = re.compile(r'[\u3400-\u9fffa-z0-9（）()&.\-]{4,48}(?:大学|学院|公司|研究院|研究所)')
_ZERO_WIDTH = re.compile(r'[\s\u200B-\u200D\uFEFF]+')


def _normalize(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    return _ZERO_WIDTH.sub('', text).translate(str.maketrans('＊﹡∗', '***'))


def _header_end(text):
    end = 0
    for line in text.splitlines(keepends=True)[:8]:
        if _SECTIONS.match(line.strip()):
            break
        end = min(300, end + len(line))
        if end == 300:
            break
    return end


def _remove_badges(text):
    text = _ACTIVITY.sub('', text)
    text = _FIRST_VIEW.sub('', text)
    return _BADGES.sub('', text)


def canonical_resume(text):
    """Ignore presentation changes while retaining career and profile facts."""
    cleaned = clean_resume_display_text(text)
    end = _header_end(cleaned)
    header = _remove_badges(_normalize(cleaned[:end]))
    return header + _normalize(cleaned[end:])


def canonical_card(text):
    """Normalize changing activity labels in an already visible list card."""
    return _CARD_ACTIONS.sub('', _remove_badges(_normalize(text)))


def _profile(text):
    header = _normalize(text[:_header_end(text)])
    facts = {}
    age = re.search(r'(?<!\d)(\d{1,2})岁', header)
    experience = re.search(r'(?<!\d)(\d{1,2}(?:\.\d+)?)年(以上)?', header)
    degree = re.search(r'博士|硕士|本科|大专|中专|高中|初中', header)
    if age:
        facts['age'] = age.group(1)
    if experience:
        facts['experience'] = experience.group(1) + (experience.group(2) or '')
    if degree:
        facts['degree'] = degree.group()
    return facts


def matches_card(card, candidate):
    """Match substantial visible content, never a masked name by itself."""
    if not all(isinstance(value, str) and value.strip() for value in (
        card.get('name'), card.get('signature'), candidate.get('name'), candidate.get('resume'),
    )):
        return False
    name = _normalize(card['name'])
    if name != _normalize(candidate['name']):
        return False
    resume = clean_resume_display_text(candidate['resume'])
    card_profile = _profile(card['signature'])
    resume_profile = _profile(resume)
    shared_facts = card_profile.keys() & resume_profile.keys()
    if any(card_profile[fact] != resume_profile[fact] for fact in shared_facts):
        return False

    visible = canonical_card(card['signature']).replace(name, '', 1)
    saved = canonical_resume(resume).replace(name, '', 1)
    if min(len(visible), len(saved)) < 48:
        return False
    blocks = SequenceMatcher(None, visible, saved, autojunk=False).get_matching_blocks()
    longest = max(block.size for block in blocks)
    anchored = any(block.size >= 6 and _ANCHOR.search(visible[block.a:block.a + block.size]) for block in blocks)
    if longest >= 48 and len(shared_facts) >= 2 and anchored:
        return True
    substantial = [block.size for block in blocks if block.size >= 16]
    return longest >= 112 or (longest >= 80 and len(substantial) >= 2 and sum(substantial) >= 112)
