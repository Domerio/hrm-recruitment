"""Decode only local QR images and expose validated BOSS website links."""

from io import BytesIO
import re
from urllib.parse import urlsplit


def safe_boss_qr_url(value):
    if (not isinstance(value, str) or not value or len(value) > 4096 or
        any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value) or
        re.search(r'%[01][0-9a-f]|%7f', value, re.IGNORECASE)):
        return ''
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if (parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None or
            parsed.port not in (None, 443) or
            not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host) or
            any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-') for label in host.split('.')) or
            not (host == 'zhipin.com' or host.endswith('.zhipin.com') or host == 'zpurl.cn')):
            return ''
    except ValueError:
        return ''
    return value


def recognize_qr(raw):
    result = {'qr_url':'', 'qr_status':'unreadable'}
    try:
        from PIL import Image
        import zxingcpp

        with Image.open(BytesIO(raw)) as source:
            if source.width > 4096 or source.height > 4096:
                return result
            image = source.convert('RGB')
        codes = zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode, return_errors=True)
        if not codes:
            return {**result, 'qr_status':'not_found'}
        if len(codes) != 1:
            return {**result, 'qr_status':'multiple'}
        if not codes[0].valid:
            return result
        url = safe_boss_qr_url(codes[0].text)
        return {'qr_url':url, 'qr_status':'recognized' if url else 'unsupported'}
    except Exception:
        # Image saving must remain usable when the local decoder cannot read a card.
        return result
