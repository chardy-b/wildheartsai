"""Offline-only RapidOCR adapter. Models must exist and match reviewed package assets."""
import hashlib
from pathlib import Path

HASHES={'PP-OCRv6_det_small.onnx':'090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
        'PP-OCRv6_rec_small.onnx':'6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
        'ch_ppocr_mobile_v2.0_cls_mobile.onnx':'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c'}

def create_engine():
    import rapidocr
    import onnxruntime as ort
    from rapidocr import RapidOCR
    ort.disable_telemetry_events()
    root=Path(rapidocr.__file__).parent/'models'
    for name,digest in HASHES.items():
        path=root/name
        if not path.is_file():raise ValueError('offline_ocr_asset_missing')
        with path.open('rb') as source:
            if hashlib.file_digest(source,'sha256').hexdigest()!=digest:raise ValueError('offline_ocr_asset_mismatch')
    return RapidOCR(params={'Global.log_level':'critical','Global.return_word_box':True,
        'EngineConfig.onnxruntime.intra_op_num_threads':1,'EngineConfig.onnxruntime.inter_op_num_threads':1,
        'Det.model_path':str(root/'PP-OCRv6_det_small.onnx'),'Rec.model_path':str(root/'PP-OCRv6_rec_small.onnx'),
        'Cls.model_path':str(root/'ch_ppocr_mobile_v2.0_cls_mobile.onnx')})

def extract(engine,image,normalize_box):
    result=engine(image);words=[]
    for line in result.word_results or []:
        if not isinstance(line,(list,tuple)):continue
        for item in line:
            if not isinstance(item,(list,tuple)) or len(item)!=3:continue
            text,confidence,polygon=item
            if polygon is None or not text:continue
            xs=[point[0] for point in polygon];ys=[point[1] for point in polygon]
            words.append({'text':text,'confidence':max(0,min(1,float(confidence))),'box':normalize_box(float(min(xs)),float(min(ys)),float(max(xs)),float(max(ys)),image.width,image.height)})
    # A model without word-level output must not claim tight word geometry.
    return '\n'.join(result.txts or []),words
