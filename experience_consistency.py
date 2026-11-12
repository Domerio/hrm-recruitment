"""Reject an explicitly declared total that contradicts a minimum-year claim.

This deliberately does not infer dates, relevance, overlaps, or partial credit.
"""

from decimal import Decimal
import re
import unicodedata


_NUMBER = r'\d+(?:\.\d+)?'
_MINIMUM_YEARS = re.compile(
    rf'(?:至少|不少于|不低于|最低|最少)\s*(?P<prefix>{_NUMBER})\s*年'
    rf'|(?<![\d.\-~～])(?P<suffix>{_NUMBER})\s*年\s*(?:及以上|或以上|以上)'
)
_DECLARED_TOTAL = re.compile(
    # Do not cross another number or a clause boundary to find a duration.
    # "合计2段，分别34个月和10个月" therefore supplies no declared total.
    rf'(?:合计|总计|累计|共计)(?P<label>[^\d，,。；;\n]{{0,30}}?)'
    rf'(?:(?P<years>{_NUMBER})\s*年(?:\s*(?P<extra_months>{_NUMBER})\s*个?月)?'
    rf'|(?P<months>{_NUMBER})\s*个?月)'
)
_NON_EXACT_TOTAL = re.compile(r'至少|不少于|不低于|超过|大于|多于|逾|预计|未来|如果|假设|包括|分别|其中|例如|单段|单个')
_SUM_CONTINUES = re.compile(r'\s*(?:[+＋]|加上|另加|再加|和\s*\d|及\s*\d|、\s*\d)')


def check_declared_experience(check):
    """Raise only for a met claim with an explicit, insufficient total duration."""
    if not isinstance(check, dict) or check.get('status') != '满足':
        return
    condition, reasoning = check.get('condition'), check.get('reasoning')
    if not isinstance(condition, str) or not isinstance(reasoning, str):
        return
    condition = unicodedata.normalize('NFKC', condition)
    reasoning = unicodedata.normalize('NFKC', reasoning)
    minimums = [Decimal(match['prefix'] or match['suffix']) * 12
                for match in _MINIMUM_YEARS.finditer(condition)]
    if not minimums:
        return
    totals = []
    for match in _DECLARED_TOTAL.finditer(reasoning):
        if _NON_EXACT_TOTAL.search(match['label']) or _SUM_CONTINUES.match(reasoning, match.end()):
            continue
        duration = (Decimal(match['years']) * 12 + Decimal(match['extra_months'] or '0')
                    if match['years'] else Decimal(match['months']))
        totals.append(duration)
    # Multiple declarations may describe different scopes. Any adequate total
    # is enough to avoid rejecting the judgment on this narrow check alone.
    if totals and max(totals) < min(minimums):
        total = format(max(totals).normalize(), 'f')
        minimum = format(min(minimums).normalize(), 'f')
        raise ValueError(f'声明的累计时长{total}个月低于最低年限要求{minimum}个月')
