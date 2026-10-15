import {describe,expect,it} from "vitest";
import {combinedEvidence,debugOverlays,type DebugRun} from "./debug";
import type {ExtractionResult} from "./contracts";
const make=(id:string,text:string,confidence?:number):DebugRun=>({id,method:id,result:{version:1,sourceSha256:'a'.repeat(64),method:'native',manifest:{},elapsedMs:0,totalPages:1,summary:'',summaryStatus:'withheld',ageAtEncounter:null,measurements:[],warnings:[],pages:[{page:1,words:[{text,box:[.1,.1,.2,.2],confidence}],figures:[],tables:[],text,foregroundCoverage:null,redaction:{rules:[],openmed:[],combined:[],text}}]} satisfies ExtractionResult});
describe('OCR evidence debugger',()=>{
  it('deduplicates agreement but preserves case-sensitive unit and numeric conflicts',()=>{
    expect(combinedEvidence([make('native','100'),make('ocr','100')],1)).toMatchObject([{sources:['native','ocr'],alternatives:[]}]);
    expect(combinedEvidence([make('native','mU'),make('ocr','MU')],1)[0].alternatives).toHaveLength(1);
    expect(debugOverlays([make('native','100'),make('ocr','700')],1,'combined','disagreements').total).toBe(1);
  });
  it('does not invent confidence or treat line geometry as comparable word alternatives',()=>{
    expect(debugOverlays([make('native','100'),make('ocr','100',.5)],1,'native','low-confidence').total).toBe(0);
    expect(debugOverlays([make('native','100'),make('ocr','100',.5)],1,'combined','low-confidence').total).toBe(1);
    expect(combinedEvidence([make('native','100'),make('docling','Glucose 100 mg/dL')],1)).toHaveLength(2);
  });
});
