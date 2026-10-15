import type { ExtractionResult, Reference } from "./contracts";
import { benchmark } from "./metrics";

export function auditResult(result: ExtractionResult, mime: string, reference?: Reference | null) {
  const pages=result.pages;
  const confidences=pages.flatMap(p=>p.words.flatMap(w=>w.confidence===undefined ? [] : [w.confidence]));
  const coverages=pages.flatMap(p=>p.foregroundCoverage===null ? [] : [p.foregroundCoverage]);
  const pixels=pages.filter(p=>p.diagnostics);
  const scanned=pages.filter(p=>p.diagnostics?.scanLike || result.method==="native" && p.text.trim().length<40 && p.figures.some(f=>(f.box[2]-f.box[0])*(f.box[3]-f.box[1])>.7)).length;
  const type=mime==="application/pdf" ? result.method!=="native" ? "PDF — native classification unavailable" : scanned===pages.length ? "PDF — scan-like proxy" : scanned ? "PDF — mixed proxy" : "PDF — text layer" : mime.startsWith("image/") ? "Image — content type unreviewed" : "Plain text — OCR bypassed";
  const gold=reference ? benchmark(result,reference) : null;
  return {method:result.method,sourceType:type,environment:result.manifest.environment_fingerprint??"legacy-unfingerprinted",pages:result.totalPages,textPages:pages.filter(p=>p.text.trim()).length,
    extractedTokens:pages.reduce((n,p)=>n+(p.text.trim().split(/\s+/).filter(Boolean).length),0),elapsedMs:result.elapsedMs,
    coverages,foregroundPixels:pixels.reduce((n,p)=>n+p.diagnostics!.foregroundPixels,0),coveredForegroundPixels:pixels.reduce((n,p)=>n+p.diagnostics!.coveredForegroundPixels,0),diagnosticPages:pixels.length,
    scoredWords:confidences.length,lowConfidenceWords:confidences.filter(c=>c<.7).length,meanConfidence:confidences.length ? confidences.reduce((a,b)=>a+b,0)/confidences.length : null,
    tables:pages.reduce((n,p)=>n+p.tables.length,0),tableCells:pages.reduce((n,p)=>n+p.tables.reduce((n,t)=>n+t.reduce((n,row)=>n+row.filter(v=>v.trim()).length,0),0),0),
    imageRegions:pages.reduce((n,p)=>n+p.figures.length,0),measurements:result.measurements.length,summaryAccepted:result.summaryStatus==="accepted",warnings:result.warnings,
    modelRevisionKnown:!!result.manifest.summary_model_revision && !result.manifest.summary_model_revision.startsWith("unknown"),
    reviewedPages:gold?.labeledPages??0,textScore:gold?.textToken??null,redactionScore:gold?.redaction??null,measurementScore:gold?.measurements??null,
    chartDataAccuracy:null,tableStructureAccuracy:null,medicalTagAccuracy:null,
  };
}
export type AuditRow=ReturnType<typeof auditResult> & {runId:string;fileId:string;createdAt:string};
function quantile(values:number[],q:number) { if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor((sorted.length-1)*q)]; }
export function auditGroups(rows:AuditRow[]) {
  // Use the latest available native classification for paired OCR runs, not OCR success itself.
  const classes=new Map<string,string>();for(const row of [...rows].reverse())if(row.method==="native" && row.sourceType.startsWith("PDF"))classes.set(row.fileId,row.sourceType);
  const groups=new Map<string,AuditRow[]>();
  for(const row of rows) {
    const type=row.sourceType.startsWith("PDF") ? classes.get(row.fileId)??row.sourceType : row.sourceType;
    const key=JSON.stringify([row.method,type,row.environment]);const list=groups.get(key)??[];list.push({...row,sourceType:type});groups.set(key,list);
  }
  return [...groups.values()].map(group=>{
    const coverage=group.flatMap(r=>r.coverages),runtime=group.map(r=>r.elapsedMs),gold=group.flatMap(r=>r.textScore ? [r.textScore] : []);
    const tp=gold.reduce((n,s)=>n+s.tp,0),predicted=gold.reduce((n,s)=>n+s.predicted,0),expected=gold.reduce((n,s)=>n+s.expected,0);
    const pages=group.reduce((n,r)=>n+r.pages,0),textPages=group.reduce((n,r)=>n+r.textPages,0);
    return {method:group[0].method,sourceType:group[0].sourceType,environment:group[0].environment,runs:group.length,documents:new Set(group.map(r=>r.fileId)).size,pages,textPages,
      textAvailability:pages ? textPages/pages:null,coveragePages:coverage.length,coverageP10:quantile(coverage,.1),coverageMedian:quantile(coverage,.5),coverageP90:quantile(coverage,.9),
      runtimeMedianMs:quantile(runtime,.5),runtimeP90Ms:quantile(runtime,.9),tableCount:group.reduce((n,r)=>n+r.tables,0),tableCells:group.reduce((n,r)=>n+r.tableCells,0),
      imageRegions:group.reduce((n,r)=>n+r.imageRegions,0),measurements:group.reduce((n,r)=>n+r.measurements,0),summaryAcceptance:group.filter(r=>r.summaryAccepted).length/group.length,
      reviewedPages:group.reduce((n,r)=>n+r.reviewedPages,0),tokenPrecision:predicted ? tp/predicted:null,tokenRecall:expected ? tp/expected:null,
      scoredWords:group.reduce((n,r)=>n+r.scoredWords,0),lowConfidenceWords:group.reduce((n,r)=>n+r.lowConfidenceWords,0),
      warnings:Object.fromEntries([...new Set(group.flatMap(r=>r.warnings))].map(w=>[w,group.filter(r=>r.warnings.includes(w)).length])),
    };
  });
}
