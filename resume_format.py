"""Keep a self-contained subset of the rich text supplied by the clipboard."""
from html import escape, unescape
from html.parser import HTMLParser
import re
import unicodedata


BLOCK = set('p div h1 h2 h3 h4 h5 h6 li ul ol pre blockquote dl dt dd table tr caption'.split())
TAGS = BLOCK | set('br hr span b strong em i u s strike del ins sub sup mark code a thead tbody tfoot th td'.split())
VOID = {'br', 'hr'}
DROP = set('head script style iframe object svg math template noscript textarea title xmp'.split())
STYLE = {
    'font-weight': r'normal|bold|[1-9]00',
    'font-style': r'normal|italic|oblique',
    'font-size': r'(?:[1-6]?\d|7[0-2])(?:\.\d{1,2})?(?:px|pt)',
    'text-decoration': r'(?:underline|line-through)(?: (?:underline|line-through))?',
    'text-decoration-line': r'(?:underline|line-through)(?: (?:underline|line-through))?',
    'text-align': r'left|right|center|justify|start|end',
    'color': r'#[0-9a-f]{3,8}|[a-z]{3,24}|rgba?\([\d.,% ]{3,40}\)',
    'background-color': r'#[0-9a-f]{3,8}|[a-z]{3,24}|rgba?\([\d.,% ]{3,40}\)',
    'white-space': r'normal|pre|pre-wrap|pre-line',
}
SECTIONS = set('个人优势 个人简介 自我评价 期望职位 求职意向 工作经历 工作经验 项目经历 项目经验 教育经历 教育背景 专业技能 技能标签 语言能力 其他能力 资格证书 培训经历 荣誉奖项 所获荣誉 获奖经历'.split())
DATED_SECTIONS = set('工作经历 工作经验 项目经历 项目经验 教育经历 教育背景'.split())
EDUCATION_SECTIONS = {'教育经历', '教育背景'}
INTENT_SECTIONS = {'期望职位', '求职意向'}
DATE_RANGE = re.compile(r'\d{4}(?:[.年/-]\s*\d{1,2}月?)?\s*[-–—~～至]+\s*(?:至今|现在|\d{4}(?:[.年/-]\s*\d{1,2}月?)?)')
LIST_ITEM = re.compile(r'^(?:\d{1,2}[.．、)）]\s*(?!\d)|[-•●▪]\s*)\S')
NAME = re.compile(r'[\u3400-\u9fff·]{1,16}(?:[*＊]{1,4}|先生|女士)')
DEGREE = re.compile(r'(?:高中|职高|中专|大专|专科|本科|学士|硕士(?:研究生)?|博士(?:研究生|后)?|研究生)(?:\s*[·•/、]\s*[^。；]{1,12})?')
SCHOOL_BADGE = re.compile(r'(?:省部共建|双一流|(?:985|211)(?:院校|工程)?|国家重点|省属重点|重点院校)')
SALARY = re.compile(r'(?:薪资)?面议|\d+(?:\.\d+)?(?:\s*[-–—~～至]\s*\d+(?:\.\d+)?)?\s*[kKwW千万元](?:/月|\s*[·x×]\s*\d+薪)?')
TAG = re.compile(r'[\u3400-\u9fffA-Za-z0-9+#.*_/()（）& -]{1,36}')
TAG_SECTIONS = {'技能标签', '专业技能', '荣誉奖项', '所获荣誉', '获奖经历'}
WORK_SECTIONS = DATED_SECTIONS - EDUCATION_SECTIONS
TAG_PROSE = re.compile(r'^(?:主要|负责|参与|完成|熟悉|熟练|精通|掌握|擅长|具备|拥有|能够|可以|从事|使用|独立|基于|根据|通过|对接|对内|对外|统筹|协助|确保|协调|良好|具有)')
TAG_ENTITY = re.compile(r'(?:公司|集团|研究院|实验室|大学|学院|中学|工程师|经理|主管|负责人|总监)$')
TAG_META = re.compile(r'^(?:\d+(?:\.\d+)?(?:岁|年(?:以上|以内|以下)?|个月|薪)|至今|现在|在职[-－].*|离职[-－].*)$')
PLATFORM_NOTICE = (
    '为妥善保护牛人在BOSS直聘平台提交、发布、展示的简历（包括但不限于在线简历、附件简历）中的个人信息'
    '（包括但不限于联系方式、期望职位、教育经历、工作经历等），任何用户原则上仅可出于自身招聘的目的，'
    '通过BOSS直聘平台在线浏览牛人简历。未经BOSS直聘及牛人本人书面授权，任何用户不得将牛人在BOSS直聘平台'
    '提交、发布、展示的简历中的个人信息，在任何第三方平台进行复制、使用、传播、存储。'
)
NOTICE_PATTERN = re.compile(r'[\s\u200b-\u200d\ufeff]*'.join(map(re.escape, PLATFORM_NOTICE)), re.IGNORECASE)
COLLAPSE_PATTERN = re.compile(r'(?m)^[^\S\r\n]*收[^\S\r\n]*起[^\S\r\n]*(?:全部[^\S\r\n]*)?(?:\d+[^\S\r\n]*[个项条][^\S\r\n]*)?(?:所获荣誉|荣誉奖项|获奖经历)?[^\S\r\n]*(?:\r?\n|$)')
FOLD_CONTROL = re.compile(r'(?:查看全部|展开全部|查看更多)(?:(?:[1-9]\d{0,3}(?:个|项|条|段|份)?)?'
                          r'(?:个人优势|个人简介|期望职位|工作经历|工作经验|项目经历|项目经验|教育经历|教育背景|'
                          r'资格证书|专业技能|所获荣誉|荣誉奖项|获奖经历|荣誉|语言能力))?')


def resume_has_folded_controls(text):
    return any(FOLD_CONTROL.fullmatch(re.sub(r'[\s\u200B-\u200D\uFEFF]', '', unicodedata.normalize('NFKC', line)))
               for line in text.splitlines())


class ResumeHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.markup, self.text, self.tags = [], [], []
        self.text_markup = {}
        self.dropped = []

    def handle_starttag(self, tag, attrs):
        if tag in DROP:
            self.dropped.append(tag)
        if self.dropped or tag not in TAGS:
            return
        clean = []
        for key, value in attrs:
            if not value:
                continue
            if key == 'style':
                rules = []
                for rule in value.lower().split(';'):
                    prop, _, val = rule.partition(':')
                    prop, val = prop.strip(), val.strip()
                    if prop in STYLE and re.fullmatch(STYLE[prop], val):
                        rules.append(f'{prop}:{val}')
                if rules:
                    clean.append(('style', ';'.join(rules)))
            elif ((tag in {'td', 'th'} and key in {'colspan', 'rowspan'}) or
                  (tag == 'ol' and key == 'start')) and re.fullmatch(r'[1-9][0-9]{0,2}', value):
                clean.append((key, value))
        self.markup.append(f'<{tag}' + ''.join(f' {k}="{escape(v)}"' for k, v in clean) + '>')
        if tag in BLOCK or tag in VOID:
            self.text.append('\n')
        if tag not in VOID:
            if len(self.tags) >= 128:
                raise ValueError('剪贴板格式嵌套过深，请分段复制')
            self.tags.append(tag)

    def handle_endtag(self, tag):
        if self.dropped:
            if tag == self.dropped[-1]:
                self.dropped.pop()
            return
        if tag in self.tags:
            while self.tags:
                end = self.tags.pop()
                self.markup.append(f'</{end}>')
                if end == tag:
                    break
            if tag in BLOCK:
                self.text.append('\n')
            elif tag in {'td', 'th'}:
                self.text.append('\t')

    def handle_data(self, data):
        if not self.dropped:
            self.text_markup[len(self.text)] = len(self.markup)
            self.markup.append(escape(data, quote=False))
            self.text.append(data)

    def sanitized_markup(self):
        return ''.join(self.markup) + ''.join(f'</{tag}>' for tag in reversed(self.tags))


def clipboard_resume(text, markup):
    if not isinstance(text, str) or len(text) > 30000:
        raise ValueError('履历文字不得超过 30000 字符')
    if not isinstance(markup, str) or len(markup) > 300000:
        raise ValueError('剪贴板格式内容过大，请分段复制')
    parser = ResumeHTML()
    parser.feed(markup)
    parser.close()
    html_text = '\n'.join(line.strip() for line in ''.join(parser.text).splitlines() if line.strip())
    text = html_text or text.strip()
    if not text or len(text) > 30000:
        raise ValueError('剪贴板中没有可用履历文字，或文字超过 30000 字符')
    safe = parser.sanitized_markup()
    if len(safe) > 300000:
        raise ValueError('剪贴板格式内容过大，请分段复制')
    return text, safe if html_text else ''


def clean_resume_display_text(text):
    return COLLAPSE_PATTERN.sub('', NOTICE_PATTERN.sub('', text)).strip()


def clean_resume_display_markup(markup):
    parser = ResumeHTML()
    parser.feed(markup)
    parser.close()
    text = ''.join(parser.text)
    matches = [*NOTICE_PATTERN.finditer(text), *COLLAPSE_PATTERN.finditer(text)]
    if not matches:
        return markup

    # Text can be split across styled spans or paragraphs. Remove its matching
    # character ranges without flattening the surrounding rich formatting.
    removed = bytearray(len(text))
    for match in matches:
        start, end = match.span()
        removed[start:end] = b'\x01' * (end-start)
    start = 0
    for index, chunk in enumerate(parser.text):
        end = start + len(chunk)
        if index in parser.text_markup and any(removed[start:end]):
            kept = ''.join(char for char, drop in zip(chunk, removed[start:end]) if not drop)
            parser.markup[parser.text_markup[index]] = escape(kept, quote=False)
        start = end
    return parser.sanitized_markup()


def display_lines(text):
    """Remove only substantial overlaps at clipboard screen boundaries."""
    lines, previous = [], []
    for screen in re.split(r'\n\s*\n', text.replace('\r\n', '\n').strip()):
        chunk = [line.strip() for line in screen.splitlines() if line.strip()]
        keys = [re.sub(r'\s+', '', line) for line in chunk]
        overlap = 0
        for trailing in (0, 1):
            end = len(previous) - trailing
            overlap = next((size for size in range(min(end, len(keys)), 2, -1)
                            if previous[end-size:end] == keys[:size] and sum(map(len, keys[:size])) >= 40), 0)
            if overlap:
                if (trailing and len(keys) > overlap and lines and len(previous[-1]) >= 16 and
                    re.sub(r'\s+', '', lines[-1]) == previous[-1] and
                    len(keys[overlap]) > len(previous[-1]) and keys[overlap].startswith(previous[-1])):
                    lines.pop()
                break
        lines.extend(chunk[overlap:])
        previous = keys
    return lines


def resume_entry(lines, index, section):
    if section not in DATED_SECTIONS:
        return None
    education = section in EDUCATION_SECTIONS
    size = 4 if education and index+3 < len(lines) and DATE_RANGE.fullmatch(lines[index+3]) else 3
    row = lines[index:index+size]
    if len(row) != size or not DATE_RANGE.fullmatch(row[-1]):
        return None
    fields = row[:-1]
    if (any(field.rstrip('：:') in SECTIONS or LIST_ITEM.match(field) or DATE_RANGE.fullmatch(field)
            or field.endswith(('：', ':')) for field in fields) or
        len(fields[0]) > 60 or any(len(field) > 40 for field in fields[1:])):
        return None
    if size == 4 and not DEGREE.fullmatch(fields[-1]):
        return None
    return fields, row[-1]


def display_entry(fields, period):
    details = ' · '.join([f'<strong>{escape(fields[0])}</strong>', *map(escape, fields[1:])])
    return (f'<p class="resume-entry"><span class="resume-entry-fields">{details}</span> '
            f'<span class="resume-entry-period">· <time>{escape(period)}</time></span></p>')


def display_tags(fields, badge=False):
    style = 'resume-tag resume-badge' if badge else 'resume-tag'
    # Repeated labels from overlapping copies need only one visual chip. The
    # stored clipboard text and AI evidence retain the original spelling/order.
    unique, seen = [], set()
    for field in fields:
        key = re.sub(r'\s+', ' ', field).casefold()
        if key not in seen:
            unique.append(field)
            seen.add(key)
    return '<p class="resume-tags">' + ' '.join(f'<span class="{style}">{escape(field)}</span>' for field in unique) + '</p>'


def is_resume_tag(line):
    return bool(TAG.fullmatch(line) and re.search(r'[\u3400-\u9fffA-Za-z]', line) and
                line.rstrip('：:') not in SECTIONS and line != '收起' and not LIST_ITEM.match(line) and
                not DATE_RANGE.search(line) and not NAME.fullmatch(line) and not DEGREE.fullmatch(line) and
                not SCHOOL_BADGE.fullmatch(line) and not SALARY.fullmatch(line) and
                not TAG_META.fullmatch(line) and not TAG_PROSE.match(line) and not TAG_ENTITY.search(line))


def trailing_tags(lines, index, section):
    if section not in WORK_SECTIONS | TAG_SECTIONS:
        return []
    end = index
    while (end < len(lines) and is_resume_tag(lines[end]) and
           not resume_entry(lines, end, section)):
        end += 1
    if section not in TAG_SECTIONS:
        if end-index < 2:
            return []
        if (end < len(lines) and lines[end].rstrip('：:') not in SECTIONS and
                not resume_entry(lines, end, section)):
            return []
    return lines[index:end]


def presentation_lines(text):
    """Split visible section columns only for display, never for AI evidence."""
    lines = []
    labels = '|'.join(map(re.escape, sorted(SECTIONS, key=len, reverse=True)))
    clean = clean_resume_display_text(text).replace('\r\n', '\n')
    # A blank paragraph boundary is stronger evidence than a visual line wrap.
    # Keep it for presentation without changing display_lines used by evidence.
    chunks = [[line.strip() for line in chunk.splitlines() if line.strip()]
              for chunk in re.split(r'\n\s*\n', clean)]
    breaks = {(left[-1], right[0]) for left, right in zip(chunks, chunks[1:]) if left and right}
    previous = None
    for line in display_lines(clean):
        if (previous, line) in breaks:
            lines.append('')
        heading = re.fullmatch(r'(' + labels + r')(?:\s*[：:]\s*|\s+)(\S.*)', line)
        if heading:
            lines.extend(heading.groups())
        else:
            lines.append(line)
        previous = line
    return lines


def inline_resume_entry(line, section):
    if section not in DATED_SECTIONS or LIST_ITEM.match(line) or TAG_PROSE.match(line):
        return None
    period = DATE_RANGE.search(line)
    if not period or period.end() != len(line) or not period.start():
        return None
    # Require a field boundary before the date, and preserve the complete
    # company/role or school/degree label instead of guessing its columns.
    prefix = line[:period.start()]
    label = prefix.strip(' \t|｜·')
    if (not prefix[-1].isspace() or not 2 <= len(label) <= 120 or
            re.search(r'[。；;：:]', label)):
        return None
    return [label], period.group()


def presentation_paragraph(lines, index, section):
    """Reflow well-supported canvas continuations, retaining ambiguous breaks."""
    fragments = [lines[index]]
    start = index
    # Source rows have no coordinates here. Require a long prose row rather
    # than treating every unnumbered row as a continuation of the last item.
    prose = bool(LIST_ITEM.match(lines[index]) or TAG_PROSE.match(lines[index]) or
                 re.search(r'[，,。；;、]', lines[index]))
    while prose and index+1 < len(lines):
        previous, following = lines[index], lines[index+1]
        width = sum(2 if unicodedata.east_asian_width(char) in {'W', 'F'} else 1 for char in previous)
        if (width < 64 or re.search(r'[。；;！？!?：:]\s*$', previous) or
                re.search(r'(?<!\d)\.\s*$', previous) or not following or
                following.rstrip('：:') in SECTIONS or LIST_ITEM.match(following) or
                re.match(r'^(?:\d{1,2}\s+\S|[①-⑳])', following) or
                TAG_PROSE.match(following) or TAG_ENTITY.search(following) or
                DATE_RANGE.fullmatch(following) or SCHOOL_BADGE.fullmatch(following) or
                (len(following) <= 32 and following.endswith(('：', ':'))) or
                (len(following) > 1 and is_resume_tag(following)) or
                resume_entry(lines, index+1, section) or inline_resume_entry(following, section) or
                trailing_tags(lines, index+1, section)):
            break
        fragments.append(following)
        index += 1
    text = fragments[0]
    for fragment in fragments[1:]:
        # A source newline between Latin words remains a word separator. CJK
        # line wrapping needs no extra space, including single-character tails.
        separator = ' ' if re.search(r'[A-Za-z0-9]$', text) and re.match(r'[A-Za-z0-9]', fragment) else ''
        text += separator + fragment
    return text, index-start+1


def profile_metadata(line):
    if len(line) > 80 or TAG_PROSE.match(line):
        return False
    return bool(re.fullmatch(r'(?:\d{1,2}岁|\d{1,2}(?:\.\d)?年(?:经验)?|' + DEGREE.pattern +
                             r'|(?:在职|离职|应届)(?:[-－—][^。；]{1,16})?)(?:[\s|｜·]+.*)?', line))


def format_plain_resume(text):
    lines = presentation_lines(text)
    parts = ['<div class="resume-structured">']
    index = 0
    identity = re.fullmatch(r'(' + NAME.pattern + r')(?:\s+([^。；]{1,40}))?', lines[0]) if lines else None
    if identity:
        parts.append('<header class="resume-header"><div class="resume-heading">')
        parts.append(f'<h2>{escape(identity[1])}</h2>')
        if identity[2]:
            parts.append(f'<p class="resume-status">{escape(identity[2])}</p>')
        parts.append('</div>')
        index = 1
        while index < min(6, len(lines)) and profile_metadata(lines[index]):
            index += 1
        if index > 1:
            parts.append('<p class="resume-meta">' + ' · '.join(map(escape, lines[1:index])) + '</p>')
        parts.append('</header>')
    section = ''
    entry_context = False
    while index < len(lines):
        line = lines[index]
        if not line:
            index += 1
            continue
        heading = line.rstrip('：:')
        entry = resume_entry(lines, index, section)
        inline_entry = inline_resume_entry(line, section)
        tags = trailing_tags(lines, index, section) if (entry_context and not entry and not inline_entry) or section in TAG_SECTIONS else []
        if heading in SECTIONS:
            section = heading
            entry_context = False
            parts.append(f'<h3>{escape(heading)}</h3>')
        elif (section in INTENT_SECTIONS and index+3 < len(lines) and SALARY.fullmatch(lines[index+3]) and
              all(len(field) <= 28 and field.rstrip('：:') not in SECTIONS for field in lines[index:index+3])):
            parts.append('<p class="resume-intent">' + ' · '.join(map(escape, lines[index:index+4])) + '</p>')
            index += 4
            continue
        elif entry or inline_entry:
            fields, period = inline_entry or entry
            parts.append(display_entry(fields, period))
            entry_context = section in WORK_SECTIONS
            index += 1 if inline_entry else len(fields)+1
            if section in EDUCATION_SECTIONS:
                start = index
                while index < len(lines) and SCHOOL_BADGE.fullmatch(lines[index]):
                    index += 1
                if index > start:
                    parts.append(display_tags(lines[start:index], badge=True))
            continue
        elif tags:
            parts.append(display_tags(tags))
            index += len(tags)
            continue
        elif LIST_ITEM.match(line):
            parts.append('<ul class="resume-list">')
            while index < len(lines) and LIST_ITEM.match(lines[index]):
                paragraph, consumed = presentation_paragraph(lines, index, section)
                parts.append(f'<li>{escape(paragraph)}</li>')
                index += consumed
            parts.append('</ul>')
            entry_context = section in WORK_SECTIONS
            continue
        elif DATE_RANGE.fullmatch(line):
            parts.append(f'<p class="resume-date">{escape(line)}</p>')
            entry_context = section in WORK_SECTIONS
        elif len(line) <= 12 and line.endswith(('：', ':')):
            parts.append(f'<p class="resume-label"><strong>{escape(line)}</strong></p>')
        elif re.fullmatch(r'(?:近14天你首次看到该牛人[，,]\s*赶紧联系TA吧[。！!]?|该牛人近期受同行BOSS欢迎[。！!]?)', line):
            parts.append(f'<p class="resume-notice">{escape(line)}</p>')
        else:
            paragraph, consumed = presentation_paragraph(lines, index, section)
            parts.append(f'<p>{escape(paragraph)}</p>')
            index += consumed
            continue
        index += 1
    parts.append('</div>')
    return ''.join(parts)


def resume_document(markup, text=''):
    # Background canvas capture stores an escaped, unstyled pre wrapper.
    # Treat that exact representation as plain text, including old records;
    # genuine rich HTML keeps its sanitized structure and original wording.
    plain = re.fullmatch(r'\s*<pre>([^<]*)</pre>\s*', markup or '', re.IGNORECASE)
    wrapped = unescape(plain[1]) if plain else None
    # clipboard_resume removes blank rows and trims line margins in the text
    # field, while its pre wrapper retains them. Compare the same visible rows
    # without ignoring wording, internal spaces, or their order. Render from
    # the wrapper so original paragraph breaks remain available for display.
    visible_lines = lambda value: [line.strip() for line in value.splitlines() if line.strip()]
    if wrapped is not None and (not text or visible_lines(wrapped) == visible_lines(text)):
        content = format_plain_resume(wrapped)
    else:
        content = clean_resume_display_markup(markup) if markup else format_plain_resume(text)
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>履历资料</title><style>'
            'html{background:#fff;color-scheme:light}*{box-sizing:border-box}'
            'body{font:14px/1.8 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;color:#293d49;max-width:880px;margin:0 auto;padding:24px 28px 36px;overflow-wrap:anywhere}'
            'pre,code{font:inherit}pre{white-space:pre-wrap!important;overflow-wrap:anywhere;max-width:100%;margin:0}'
            'table{border-collapse:collapse;table-layout:fixed;max-width:100%;width:100%}td,th{border:1px solid #dce4e9;padding:7px 10px;overflow-wrap:anywhere}'
            '.resume-header{padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid #e6ecef}'
            '.resume-heading{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}'
            '.resume-structured h2{margin:0;font-size:22px;line-height:1.4;color:#163c39;letter-spacing:.02em}'
            '.resume-meta,.resume-date,.resume-status{color:#697b86}.resume-structured .resume-status{font-size:12px;margin:0}.resume-structured .resume-meta{margin:5px 0 0;font-size:13px}'
            '.resume-structured h3{margin:23px 0 11px;padding:6px 11px;border-left:3px solid #187f76;border-radius:0 6px 6px 0;background:#edf6f4;color:#205f59;font-size:15px;line-height:1.6}'
            '.resume-structured p{margin:5px 0}.resume-structured .resume-entry{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;margin:16px 0 8px}'
            '.resume-entry-fields{flex:1 1 200px;min-width:0}.resume-entry-fields,.resume-entry-period{display:inline-block;max-width:100%;color:#526b78}'
            '.resume-entry-fields strong{color:#233743;font-weight:600}.resume-entry-period{font-size:12px;font-variant-numeric:tabular-nums}'
            '.resume-intent{color:#334d5a}.resume-structured .resume-tags{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px;margin:.55em 0 .95em}'
            '.resume-tag{display:inline-block;max-width:100%;box-sizing:border-box;padding:2px 9px;border:1px solid #dce8e6;border-radius:5px;background:#f2f7f6;color:#3f655f;font-size:12px;line-height:1.65;overflow-wrap:anywhere}'
            '.resume-badge{border-color:#d7e7f4;background:#e8f2fa;color:#275e83}'
            '.resume-list{list-style:none;margin:8px 0 12px;padding-left:12px;border-left:2px solid #e3ece9}'
            '.resume-list li+li{margin-top:5px}.resume-label{color:#334d5a;padding-top:4px}'
            '.resume-notice{padding:7px 11px;border-radius:6px;background:#f2f7f8;color:#607780;font-size:12px}'
            '@media(max-width:430px){body{padding:18px 16px 28px;font-size:14px}.resume-structured h2{font-size:21px}.resume-structured h3{margin-top:21px}.resume-entry-period{flex-basis:100%}}'
            '@media print{body{max-width:none;padding:0}.resume-structured h3{break-after:avoid}.resume-entry{break-inside:avoid}}'
            '</style><body>' + content + '</body></html>').encode('utf-8')
