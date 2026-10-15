import {describe,expect,it} from "vitest";
import {auditGroups,auditResult} from "./audit";
import type {ExtractionResult} from "./contracts";
const result={method:'native',manifest:{},elapsedMs:100,totalPages:1,pages:[{page:1,text:'',words:[],tables:[],figures:[{box:[0,0,1,1],caption:'',origin:'unknown'}],foregroundCoverage:null}],measurements:[],summaryStatus:'withheld',warnings:[]} as unknown as ExtractionResult;
describe('honest extraction audit metrics',()=>{
  it('reports scan-like proxies without inventing real-document accuracy',()=>{
    const row=auditResult(result,'application/pdf');
    expect(row.sourceType).toContain('scan-like');expect(row.textScore).toBeNull();expect(row.tableStructureAccuracy).toBeNull();expect(row.chartDataAccuracy).toBeNull();
  });
  it('uses paired native classification and leaves missing coverage and gold scores unscored',()=>{
    const native={...auditResult(result,'application/pdf'),runId:'native',fileId:'doc',createdAt:'2026-01-01'};
    const ocr={...auditResult({...result,method:'tesseract'},'application/pdf'),runId:'ocr',fileId:'doc',createdAt:'2026-01-02'};
    const group=auditGroups([ocr,native])[0];expect(group.sourceType).toContain('scan-like');expect(group.coverageMedian).toBeNull();expect(group.tokenRecall).toBeNull();
  });
});
