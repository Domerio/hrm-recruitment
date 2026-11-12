"""On-device Chinese OCR using bundled RapidOCR models. No remote OCR calls."""
from pathlib import Path
import sys
import threading

OCR_LOCK = threading.Lock()
ENGINE = None
RUNTIME = Path(__file__).resolve().parent / '.ocr-runtime'


def get_engine():
    global ENGINE
    if ENGINE is not None:
        return ENGINE
    if RUNTIME.is_dir() and str(RUNTIME) not in sys.path:
        sys.path.insert(0, str(RUNTIME))
    try:
        import rapidocr
        from rapidocr import RapidOCR
    except ImportError:
        raise ValueError('本机 OCR 依赖未安装，请安装 requirements.txt 后重启服务') from None
    model_dir = Path(rapidocr.__file__).resolve().parent / 'models'
    models = {'Det': 'PP-OCRv6_det_small.onnx', 'Rec': 'PP-OCRv6_rec_small.onnx', 'Cls': 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'}
    if any(not (model_dir / filename).is_file() for filename in models.values()):
        raise ValueError('本机 OCR 模型缺失，请重新安装 rapidocr 3.10.0；不会上传图片到外部识别服务')
    params = {key+'.model_path': str(model_dir / filename) for key, filename in models.items()}
    params.update({'Global.log_level': 'error', 'EngineConfig.onnxruntime.intra_op_num_threads': 2, 'EngineConfig.onnxruntime.inter_op_num_threads': 2})
    ENGINE = RapidOCR(params=params)
    return ENGINE


def recognize_png(raw):
    if not OCR_LOCK.acquire(blocking=False):
        raise ValueError('本机正在识别另一张图片，请稍后重试')
    try:
        result = get_engine()(raw, return_word_box=True)
        lines = []
        for i, text in enumerate(result.txts or []):
            words = []
            for word, confidence, points in (result.word_results[i] if result.word_results else []):
                xs, ys = [p[0] for p in points], [p[1] for p in points]
                words.append({'text': word, 'confidence': float(confidence), 'x': float(min(xs)), 'y': float(min(ys)), 'width': float(max(xs)-min(xs)), 'height': float(max(ys)-min(ys))})
            lines.append({'text': text, 'confidence': float(result.scores[i]), 'words': words})
        return {'text': '\n'.join(line['text'] for line in lines), 'lines': lines, 'engine': 'RapidOCR (local)', 'language': 'zh-en'}
    except ValueError:
        raise
    except Exception:
        raise ValueError('本机 OCR 读取失败；请检查截图尺寸和本地模型依赖') from None
    finally:
        OCR_LOCK.release()
