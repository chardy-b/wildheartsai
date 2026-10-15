"""Only authored synthetic text; no model assets or document access."""
import json
import unittest
from unittest.mock import Mock
from inference import chunks, synthesize, validated_measurement

def page(number,text): return {"page":number,"text":text,"redaction":{"text":text}}
FACT={"name":"Glucose","value":"100","unit":"mg/dL","date":"","range":"","page":1,"evidence":"Glucose 100 mg/dL"}

class InferenceTests(unittest.TestCase):
    def test_chunks_cover_all_input_preserve_pages_and_overlap(self):
        text="A"*19980+"BOUNDARY_EVIDENCE"+"B"*45000
        parts,total=chunks([page(1,text),page(2,"LAST_PAGE")])
        self.assertEqual(total,len(parts));self.assertTrue(all(len(p)<=20000 for p in parts))
        self.assertTrue(any("BOUNDARY_EVIDENCE" in p for p in parts));self.assertIn("PAGE 2\nLAST_PAGE",parts[-1])
        compact,total=chunks([page(i,"SHORT") for i in range(1,101)])
        self.assertEqual(total,1);self.assertIn("PAGE 100",compact[0])

    def test_summary_privacy_failure_does_not_skip_valid_measurements(self):
        privacy=Mock();privacy.safe_summary.return_value=False
        infer=Mock(side_effect=[json.dumps({"summary":"synthetic"}),json.dumps({"measurements":[FACT,FACT,{**FACT,"value":"700"}]})])
        summary,facts,status,warnings,meta=synthesize([page(1,FACT['evidence'])],privacy,[],None,infer,lambda:None)
        self.assertEqual((summary,status),("","withheld"));self.assertEqual(facts,[FACT])
        self.assertIn("measurement_candidate_rejected",warnings);self.assertEqual(meta['measurement_chunks_processed'],'1')

    def test_partial_large_input_never_claims_a_complete_summary(self):
        infer=lambda mode,text: json.dumps({"measurements":[]}) if '"measurements"' in text else json.dumps({"summary":"synthetic finding"})
        privacy=Mock();privacy.safe_summary.return_value=True
        summary,_,status,warnings,meta=synthesize([page(1,"x"*200000)],privacy,[],None,infer,lambda:None)
        self.assertEqual((summary,status),("","withheld"));self.assertIn('summary_partial_input',warnings);self.assertIn('measurement_partial_input',warnings)
        self.assertEqual(meta['summary_chunks_processed'],'8')

    def test_empty_pages_do_not_generate_findings(self):
        infer=Mock()
        result=synthesize([page(1,"")],Mock(),[],None,infer,lambda:None)
        self.assertEqual(result[2],'withheld');infer.assert_not_called()

    def test_complete_large_document_synthesizes_all_chunks_and_deduplicates(self):
        privacy=Mock();privacy.safe_summary.return_value=True
        requests=[]
        def infer(mode,text):
            requests.append(text)
            return json.dumps({'measurements':[FACT]}) if '"measurements"' in text else json.dumps({'summary':'synthetic finding'})
        result=synthesize([page(1,FACT['evidence']+'x'*65000)],privacy,[],None,infer,lambda:None)
        self.assertEqual(result[2],'accepted');self.assertEqual(result[1],[FACT]);self.assertEqual(result[4]['summary_chunks_total'],'4')
        self.assertEqual(len(requests),9);self.assertIn('SUMMARIES:',requests[-1]);self.assertTrue(all(len(r)<21000 for r in requests))

    def test_final_synthesis_has_its_own_privacy_gate(self):
        privacy=Mock();privacy.safe_summary.side_effect=[True,True,False]
        infer=lambda mode,text:json.dumps({'measurements':[]}) if '"measurements"' in text else json.dumps({'summary':'synthetic'})
        result=synthesize([page(1,'x'*30000)],privacy,[],None,infer,lambda:None)
        self.assertEqual(result[2],'withheld');self.assertEqual(result[0],'');self.assertIn('summary_privacy_or_format_check_failed',result[3])

    def test_infrastructure_outage_still_propagates(self):
        class Outage(Exception):pass
        with self.assertRaises(Outage):synthesize([page(1,"synthetic")],Mock(),[],None,Mock(side_effect=Outage),lambda:None,(Outage,))

    def test_time_budget_and_wrong_page_are_explicit(self):
        infer=Mock()
        result=synthesize([page(1,'synthetic')],Mock(),[],None,infer,lambda:None,now=Mock(side_effect=[0,601]))
        self.assertIn('inference_time_budget_exceeded',result[3]);self.assertEqual(result[2],'withheld');infer.assert_not_called()
        self.assertFalse(validated_measurement({**FACT,'page':True},[page(1,FACT['evidence'])]))
        self.assertFalse(validated_measurement({**FACT,'page':2},[page(1,FACT['evidence'])]))

if __name__ == '__main__':unittest.main()
