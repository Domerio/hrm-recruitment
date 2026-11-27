import io
import unittest
import zipfile

from PIL import Image

from file_text_extraction import extract_file_text


class FileTextExtractionTests(unittest.TestCase):
    def test_extracts_utf8_text_and_normalizes_blank_lines(self):
        result = extract_file_text('resume.txt', '姓名 张三\n\n工作经历 视觉算法'.encode(), lambda _: {})
        self.assertEqual(result, '姓名 张三\n工作经历 视觉算法')

    def test_extracts_docx_paragraphs(self):
        document = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>教育经历</w:t></w:r></w:p>
        <w:p><w:r><w:t>测试大学 本科</w:t></w:r></w:p></w:body></w:document>'''.encode()
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('word/document.xml', document)
        self.assertEqual(extract_file_text('resume.docx', stream.getvalue(), lambda _: {}),
                         '教育经历\n测试大学 本科')

    def test_validates_image_then_uses_local_ocr(self):
        stream = io.BytesIO()
        Image.new('RGB', (80, 80), 'white').save(stream, format='PNG')
        calls = []
        result = extract_file_text('resume.png', stream.getvalue(),
                                   lambda raw: calls.append(raw) or {'text':'项目经历\n机器视觉检测'})
        self.assertEqual(result, '项目经历\n机器视觉检测')
        self.assertEqual(calls, [stream.getvalue()])

    def test_rejects_empty_image_ocr_result(self):
        stream = io.BytesIO()
        Image.new('RGB', (80, 80), 'white').save(stream, format='JPEG')
        with self.assertRaisesRegex(ValueError, '未识别到文字'):
            extract_file_text('resume.jpg', stream.getvalue(), lambda _: {'text':''})

    def test_rejects_unsupported_files(self):
        with self.assertRaisesRegex(ValueError, '支持 PDF'):
            extract_file_text('resume.doc', b'legacy', lambda _: {})


if __name__ == '__main__':
    unittest.main()
