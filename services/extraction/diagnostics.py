"""Bounded, local page diagnostics. Suspicious ink is a review proxy, not OCR truth."""
from PIL import Image, ImageChops, ImageDraw

def page_diagnostics(image, words, kind, native_characters=None, image_regions=0):
    sample = image.convert("L")
    sample.thumbnail((1000, 1000))
    foreground = sample.point(lambda p: 255 if p < 220 else 0)
    mask = Image.new("L", sample.size)
    draw = ImageDraw.Draw(mask)
    for word in words:
        x, y, r, b = word["box"]
        draw.rectangle((int(x*sample.width), int(y*sample.height), int(r*sample.width), int(b*sample.height)), fill=255)
    covered = ImageChops.multiply(foreground, mask)
    uncovered = ImageChops.subtract(foreground, covered)
    total = sum(foreground.histogram()[1:])
    matched = sum(covered.histogram()[1:])
    regions = []
    # 20x20 tiles make problem areas visible without persisting page pixels.
    for row in range(20):
        for col in range(20):
            bounds = (col*sample.width//20, row*sample.height//20, (col+1)*sample.width//20, (row+1)*sample.height//20)
            area = max(1, (bounds[2]-bounds[0])*(bounds[3]-bounds[1]))
            ink = sum(foreground.crop(bounds).histogram()[1:])
            missing = sum(uncovered.crop(bounds).histogram()[1:])
            if ink/area >= .02 and missing/max(1,ink) >= .65:
                regions.append({"box": [col/20,row/20,(col+1)/20,(row+1)/20], "uncoveredFraction": missing/max(1,ink)})
    confidences = [w["confidence"] for w in words if w.get("confidence") is not None]
    result = {"version": 1, "textSource": kind, "foregroundPixels": total, "coveredForegroundPixels": matched,
              "sampleWidth": sample.width, "sampleHeight": sample.height, "uncoveredRegions": regions,
              "lowConfidenceWords": sum(c < .7 for c in confidences), "confidenceWords": len(confidences),
              "imageRegions": image_regions}
    if native_characters is not None:
        result["nativeCharacters"] = native_characters
        result["scanLike"] = native_characters < 40 and image_regions > 0
    sample.close(); foreground.close(); mask.close(); covered.close(); uncovered.close()
    return result
