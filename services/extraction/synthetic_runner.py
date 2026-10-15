"""Parser-only evaluation of the known-answer synthetic corpus. Outputs scores, not text."""
import argparse
from collections import Counter
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import time
import platform
from parsers import parse,rendered_pages,box

def tokens(text): return re.sub(r'\s+',' ',text.casefold()).split()
def distance(a,b):
    previous=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        row=[i]
        for j,y in enumerate(b,1):row.append(min(row[-1]+1,previous[j]+1,previous[j-1]+(x!=y)))
        previous=row
    return previous[-1]
def prf(actual,expected):
    a,e=Counter(actual),Counter(expected);tp=sum((a&e).values())
    return {'precision':tp/sum(a.values()) if a else None,'recall':tp/sum(e.values()) if e else None,'tp':tp,'predicted':sum(a.values()),'expected':sum(e.values())}
def score(result,case):
    actual='\n'.join(p['text'] for p in result);expected=case['text'];a,e=tokens(actual),tokens(expected)
    values={'token':prf(a,e),'word_error_rate':distance(a,e)/len(e) if e else None,
            'character_error_rate':distance(' '.join(a),' '.join(e))/len(' '.join(e)) if e else None,
            'numeric_tokens':prf(re.findall(r'\d+(?:\.\d+)?',actual),re.findall(r'\d+(?:\.\d+)?',expected)),
            'visual_coverage':result[0]['foregroundCoverage'],'detected_tables':sum(len(p['tables']) for p in result),
            'chart_point_extraction':'not_attempted'}
    table=next((r for r in case['regions'] if r['kind']=='table'),None)
    if table:
        gold=[(r,c,v) for r,row in enumerate(table['cells']) for c,v in enumerate(row)]
        predicted=[(r,c,v) for p in result for t in p['tables'] for r,row in enumerate(t) for c,v in enumerate(row)]
        values['table_cells_exact']=prf(predicted,gold)
        values['table_text_tokens']=prf(tokens(actual),tokens(table['text']))
    chart=next((r for r in case['regions'] if r['kind']=='chart_labels'),None)
    if chart:values['chart_label_tokens']=prf(tokens(actual),tokens(chart['text']))
    return values

def rapid_engine(gpu):
    import rapidocr
    import onnxruntime as ort
    from rapidocr import RapidOCR
    from rapidocr.inference_engine.onnxruntime.provider_config import ProviderConfig
    ort.disable_telemetry_events()
    ProviderConfig.dml_ep_cfg=lambda self:dict(self.cfg.dml_ep_cfg)
    root=Path(rapidocr.__file__).parent/'models'
    paths={'Det':root/'PP-OCRv6_det_small.onnx','Rec':root/'PP-OCRv6_rec_small.onnx','Cls':root/'ch_ppocr_mobile_v2.0_cls_mobile.onnx'}
    if any(not p.is_file() for p in paths.values()):raise ValueError('offline_model_missing')
    params={'Global.log_level':'critical','EngineConfig.onnxruntime.use_dml':gpu is not None,'EngineConfig.onnxruntime.dml_ep_cfg':{'device_id':str(gpu or 0)}}
    params.update({f'{task}.model_path':str(path) for task,path in paths.items()})
    engine=RapidOCR(params=params)
    from PIL import Image,ImageDraw
    probe=Image.new('RGB',(400,100),'white');ImageDraw.Draw(probe).text((10,10),'Synthetic warmup 123',fill='black');engine(probe);probe.close()
    manifest={'rapidocr':importlib.metadata.version('rapidocr'),'onnxruntime':ort.__version__,'providers':engine.text_rec.session.session.get_providers(),
              'models':{k:hashlib.file_digest(p.open('rb'),'sha256').hexdigest() for k,p in paths.items()}}
    if gpu is not None and 'DmlExecutionProvider' not in manifest['providers']:raise ValueError('unexpected_cpu_fallback')
    return engine,manifest

def run(corpus,output,methods,gpu=None):
    reference=json.loads((corpus/'reference.json').read_text());rows=[];manifest={'python':platform.python_version(),'pdfplumber':importlib.metadata.version('pdfplumber'),'pypdfium2':importlib.metadata.version('pypdfium2'),'raster_input':'canonical pre-rendered images shared between OCR methods'}
    engine=None
    if 'rapidocr' in methods:
        engine,rapid_manifest=rapid_engine(gpu);manifest.update(rapid_manifest)
    if 'tesseract' in methods:
        import pytesseract
        manifest['tesseract']=str(pytesseract.get_tesseract_version())
    for case in reference['cases']:
        for method in methods:
            started=time.monotonic()
            if method=='rapidocr':
                pages=[]
                for n,image in rendered_pages(corpus/case.get('image',case['file']),'image/png' if case.get('image') else 'application/pdf'):
                    result=engine(image);words=[]
                    for polygon,text,confidence in zip(result.boxes if result.boxes is not None else [],result.txts or [],result.scores or []):
                        xs,ys=polygon[:,0],polygon[:,1]
                        words.append({'text':text,'box':box(float(min(xs)),float(min(ys)),float(max(xs)),float(max(ys)),image.width,image.height),'confidence':float(confidence)})
                    from parsers import coverage
                    pages.append({'page':n,'text':'\n'.join(result.txts or []),'words':words,'tables':[],'foregroundCoverage':coverage(image,words)})
                    image.close()
            else:
                raster=method=='tesseract' and case.get('image')
                pages=parse(corpus/(case['image'] if raster else case['file']),'image/png' if raster else 'application/pdf',method,lambda *args:None,lambda:None)
            rows.append({'case':case['name'],'source_type':case['type'],'method':method,'elapsed_ms':(time.monotonic()-started)*1000,**score(pages,case)})
            print(json.dumps({'synthetic_case':case['name'],'method':method,'finished':True}),flush=True)
    result={'corpus':reference['corpus'],'ground_truth':'programmatically authored; not clinical or real-document validation','manifest':manifest,'scores':rows}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(result,indent=2))
    print(json.dumps({'cases':len(reference['cases']),'runs':len(rows),'output_saved':True}),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('corpus',type=Path);parser.add_argument('output',type=Path);parser.add_argument('--methods',default='native,tesseract');parser.add_argument('--gpu',type=int)
    args=parser.parse_args();run(args.corpus,args.output,args.methods.split(','),args.gpu)
