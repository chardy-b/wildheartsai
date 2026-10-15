"""Known-text synthetic stress corpus. Contains no uploaded documents or real people."""
import argparse
import io
import json
from pathlib import Path
import random
from PIL import Image,ImageEnhance,ImageFilter
import pypdfium2
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

PAGE=(612,792)
PROSE=['SYNTHETIC CLINICAL DOCUMENT - TEST DATA ONLY','Patient: Jane Example','DOB: 1980-06-20','MRN: SAMPLE123','Glucose 100 mg/dL','Hemoglobin 13.5 g/dL','Sodium 140 mmol/L','Temperature 37.2 C','Pulse 72 beats/min','No real patient data is present in this fixture.']
ROWS=[['Test','Value','Unit','Reference range'],['Glucose','100','mg/dL','70-99'],['Hemoglobin','13.5','g/dL','12.0-16.0'],['Sodium','140','mmol/L','135-145'],['Potassium','4.1','mmol/L','3.5-5.1']]

def vector(kind):
    output=io.BytesIO(); c=canvas.Canvas(output,pagesize=PAGE); lines=[]; regions=[]
    def line(text,x,y,size=12):
        c.setFont('Helvetica',size);c.drawString(x,y,text);lines.append((y,x,text))
    if kind in {'ruled_table','borderless_table'}:
        line('SYNTHETIC LAB TABLE - TEST DATA ONLY',40,750)
        xs=[40,190,280,380,570]; ys=[710,680,650,620,590,560]
        for row,values in enumerate(ROWS):
            for col,text in enumerate(values): line(text,xs[col]+6,ys[row]-21,11)
        if kind=='ruled_table':
            for x in xs:c.line(x,ys[-1],x,ys[0])
            for y in ys:c.line(xs[0],y,xs[-1],y)
        regions.append({'kind':'table','box':[40/612,(792-710)/792,570/612,(792-560)/792],'text':'\n'.join(' '.join(r) for r in ROWS),'cells':ROWS})
    elif kind=='multicolumn':
        for i in range(10):line(f'Left section {i+1}: glucose {90+i} mg/dL',35,740-i*32,10)
        for i in range(10):line(f'Right section {i+1}: pulse {60+i} beats/min',315,740-i*32,10)
    elif kind=='chart':
        line('SYNTHETIC PULSE CHART',50,750)
        line('Pulse (beats/min)',50,700,11)
        c.line(80,380,80,650);c.line(80,380,550,380)
        points=[(110,470),(190,530),(270,500),(350,590),(430,560),(510,620)]
        for i,(x,y) in enumerate(points):
            c.circle(x,y,4,stroke=1,fill=1)
            line(str(i+1),x-3,360,10)
            if i:c.line(*points[i-1],x,y)
        for val,y in [(50,400),(60,460),(70,520),(80,580),(90,640)]:line(str(val),50,y,10)
        line('Visit number',250,330,11)
        regions.append({'kind':'chart_labels','box':[.05,.1,.95,.65],'text':'SYNTHETIC PULSE CHART Pulse (beats/min) 1 2 3 4 5 6 50 60 70 80 90 Visit number','visualPoints':[50+(y-400)/6 for _,y in points]})
    else:
        for i,text in enumerate(PROSE):line(text,45,740-i*35,6 if kind=='tiny_text' else 12)
    c.showPage();c.save()
    expected='\n'.join(t for _,_,t in (lines if kind=='multicolumn' else sorted(lines,key=lambda t:(-t[0],t[1]))))
    return output.getvalue(),expected,regions

def build(root):
    root.mkdir(parents=True,exist_ok=True);cases=[]
    for kind in ['born_digital','ruled_table','borderless_table','multicolumn','tiny_text','chart']:
        data,text,regions=vector(kind);(root/f'{kind}.pdf').write_bytes(data)
        cases.append({'name':kind,'file':f'{kind}.pdf','type':'native_pdf','text':text,'regions':regions})
    original,text,_=vector('born_digital');doc=pypdfium2.PdfDocument(original);page=doc[0];bitmap=page.render(scale=2.5);base=bitmap.to_pil().copy();bitmap.close();page.close();doc.close()
    for kind in ['clean_scan','low_resolution_scan','rotated_scan','upside_down_scan','low_contrast_scan','noisy_scan','perspective_scan']:
        image=base.copy()
        if kind=='low_resolution_scan':image=image.resize((350,453)).resize(base.size)
        if kind=='rotated_scan':image=image.rotate(5,resample=Image.Resampling.BICUBIC,fillcolor='white')
        if kind=='upside_down_scan':image=image.rotate(180)
        if kind=='low_contrast_scan':image=ImageEnhance.Contrast(image).enhance(.18)
        if kind=='noisy_scan':
            rng=random.Random(20261014);gray=image.convert('L');pixels=bytearray(gray.tobytes())
            for i,p in enumerate(pixels):pixels[i]=max(0,min(255,p+round(rng.gauss(0,22))))
            image=Image.frombytes('L',gray.size,bytes(pixels)).convert('RGB')
        if kind=='perspective_scan':
            w,h=image.size;image=image.transform(image.size,Image.Transform.QUAD,(80,50,0,h-60,w-60,h,w,0),resample=Image.Resampling.BICUBIC,fillcolor='white')
        png=root/f'{kind}.png';image.save(png)
        output=io.BytesIO();c=canvas.Canvas(output,pagesize=PAGE);c.drawImage(ImageReader(image),0,0,*PAGE);c.showPage();c.save()
        (root/f'{kind}.pdf').write_bytes(output.getvalue())
        cases.append({'name':kind,'file':f'{kind}.pdf','image':png.name,'type':'raster_pdf','text':text,'regions':[]})
        image.close()
    base.close();(root/'reference.json').write_text(json.dumps({'corpus':'synthetic-stress/v1','cases':cases},indent=2))
    print(json.dumps({'corpus':'synthetic-stress/v1','cases':len(cases)}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);build(parser.parse_args().output)
