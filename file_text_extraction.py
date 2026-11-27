"""Extract plain text from locally uploaded resume files."""

import io
import zipfile
from pathlib import Path
from xml.etree import ElementTree


MAX_TEXT_LENGTH = 30_000
MAX_IMAGE_PIXELS = 25_000_000
SUPPORTED_IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp'}


def _clean_text(value):
    lines = [' '.join(line.split()) for line in str(value or '').replace('\r', '\n').split('\n')]
    return '\n'.join(line for line in lines if line).strip()[:MAX_TEXT_LENGTH]


def _extract_docx(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        info = archive.getinfo('word/document.xml')
        if info.file_size > 5_000_000:
            raise ValueError('DOCX 解压后的正文过大')
        root = ElementTree.fromstring(archive.read(info))
    namespace = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    paragraphs = []
    for paragraph in root.findall('.//w:p', namespace):
        text = ''.join(node.text or '' for node in paragraph.findall('.//w:t', namespace)).strip()
        if text:
            paragraphs.append(text)
    return '\n'.join(paragraphs)


def _extract_pdf(raw):
    if not raw.startswith(b'%PDF-'):
        raise ValueError('PDF 文件格式无效')
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ValueError('PDF 读取依赖未安装，请安装 requirements.txt 后重启服务') from None
    try:
        reader = PdfReader(io.BytesIO(raw), strict=False)
        if reader.is_encrypted and not reader.decrypt(''):
            raise ValueError('PDF 已加密，请解除密码后重新上传')
        if len(reader.pages) > 40:
            raise ValueError('PDF 最多支持 40 页')
        return '\n'.join(page.extract_text() or '' for page in reader.pages)
    except ValueError:
        raise
    except Exception:
        raise ValueError('PDF 读取失败，请检查文件是否完整') from None


def _extract_image(raw, recognize_image):
    try:
        from PIL import Image, UnidentifiedImageError
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            image_format = image.format
            image.verify()
        if image_format not in {'PNG', 'JPEG', 'WEBP'}:
            raise ValueError('图片仅支持 PNG、JPG、JPEG 或 WEBP')
        if width < 40 or height < 40 or width * height > MAX_IMAGE_PIXELS:
            raise ValueError('图片尺寸无效或像素过大')
    except ValueError:
        raise
    except (UnidentifiedImageError, OSError):
        raise ValueError('图片文件损坏或格式无效') from None
    return recognize_image(raw).get('text', '')


def extract_file_text(name, raw, recognize_image):
    """Return normalized text for a supported resume upload."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError('缺少上传文件名')
    if not isinstance(raw, bytes) or not raw:
        raise ValueError('上传文件为空')
    suffix = Path(name.strip()).suffix.lower()
    if suffix == '.txt':
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('TXT 文件必须使用 UTF-8 编码') from None
    elif suffix == '.docx':
        text = _extract_docx(raw)
    elif suffix == '.pdf':
        text = _extract_pdf(raw)
    elif suffix in SUPPORTED_IMAGE_SUFFIXES:
        text = _extract_image(raw, recognize_image)
    else:
        raise ValueError('支持 PDF、DOCX、UTF-8 TXT、PNG、JPG、JPEG 和 WEBP 文件')
    text = _clean_text(text)
    if not text:
        if suffix == '.pdf':
            raise ValueError('PDF 中未读取到文字；扫描版 PDF 请逐页截图后上传图片')
        if suffix in SUPPORTED_IMAGE_SUFFIXES:
            raise ValueError('图片中未识别到文字，请上传更清晰、完整的简历图片')
        raise ValueError('文档中未读取到文字')
    return text
