import unittest
import base64
from PIL import Image, ImageDraw
from diagnostics import page_diagnostics

class DiagnosticTests(unittest.TestCase):
    def test_covered_ink_and_uncovered_review_regions(self):
        image=Image.new('RGB',(200,200),'white'); draw=ImageDraw.Draw(image)
        draw.rectangle((10,10,39,29),fill='black'); draw.rectangle((120,120,159,159),fill='black')
        result=page_diagnostics(image,[{'box':[.05,.05,.2,.15],'confidence':.4}],'tesseract')
        self.assertGreater(result['foregroundPixels'],result['coveredForegroundPixels'])
        self.assertEqual(result['lowConfidenceWords'],1)
        self.assertTrue(any(r['box'][0]>=.6 for r in result['uncoveredRegions']))
        self.assertLessEqual(len(result['uncoveredRegions']),400)
    def test_empty_page_is_not_a_scan_or_accuracy_claim(self):
        result=page_diagnostics(Image.new('RGB',(100,100),'white'),[],'native',0,0)
        self.assertEqual(result['foregroundPixels'],0); self.assertFalse(result['scanLike'])
        self.assertEqual(result['uncoveredRegions'],[])

    def test_spatial_mask_bit_order_threshold_and_bound(self):
        image = Image.new('L', (4, 1), 'white')
        image.putpixel((0, 0), 0); image.putpixel((2, 0), 219); image.putpixel((3, 0), 220)
        mask = page_diagnostics(image, [], 'native')['foregroundMask']
        self.assertEqual(mask, {'width': 4, 'height': 1, 'bits': 'BQ=='})
        large = page_diagnostics(Image.new('L', (1000, 2000), 'black'), [], 'native')['foregroundMask']
        self.assertEqual((large['width'], large['height']), (100, 200))
        self.assertEqual(len(base64.b64decode(large['bits'])), 2500)

if __name__=='__main__': unittest.main()
