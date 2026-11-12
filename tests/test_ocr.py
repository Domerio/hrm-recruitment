import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import local_ocr

class LocalOcrTests(TestCase):
    def test_word_coordinates_and_confidence_remain_associated_for_canvas_clicks(self):
        result=SimpleNamespace(txts=['查看全部'],scores=[.99],word_results=[(('查看全部',.98,[[20,30],[100,30],[100,50],[20,50]]),)])
        with patch.object(local_ocr,'get_engine',return_value=lambda *args,**kwargs:result):
            parsed=local_ocr.recognize_png(b'fixture')
        self.assertEqual(parsed['lines'][0]['words'][0],{'text':'查看全部','confidence':.98,'x':20.,'y':30.,'width':80.,'height':20.})
        self.assertFalse(local_ocr.OCR_LOCK.locked())

    def test_engine_failure_releases_lock_and_busy_engine_rejects_concurrent_call(self):
        with patch.object(local_ocr,'get_engine',side_effect=RuntimeError('native engine error')):
            with self.assertRaisesRegex(ValueError,'读取失败'):local_ocr.recognize_png(b'fixture')
        self.assertFalse(local_ocr.OCR_LOCK.locked())
        with local_ocr.OCR_LOCK:
            with self.assertRaisesRegex(ValueError,'正在识别'):local_ocr.recognize_png(b'fixture')
