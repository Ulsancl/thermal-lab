"""Draw Thermal Lab's original heater/heat-sink icon (optional Pillow tool)."""
from pathlib import Path
from PIL import Image, ImageDraw
target = Path(__file__).resolve().parents[1] / 'desktop' / 'assets'
target.mkdir(parents=True, exist_ok=True)
scale = 3
image = Image.new('RGBA', (512*scale, 512*scale))
draw = ImageDraw.Draw(image)
def xy(values): return tuple(round(v*scale) for v in values)
def line(points, color, width): draw.line(xy(points), color, width*scale, joint='curve')
def box(bounds, color, outline, radius=8, width=3): draw.rounded_rectangle(xy(bounds),radius*scale,color,outline,width*scale)
box((8,8,504,504),'#142536','#45657a',98,7)
box((71,388,441,419),'#425665','#a4b9c6',10,4)
# Copper heater and thin contact interface sit below a distinct fin cartridge.
box((126,302,386,381),'#bc6432','#ffbb76',14,5)
line((143,356,189,336,229,356,272,336,317,356,369,333),'#ffd392',5)
box((120,282,392,298),'#496273','#bddbe6',4,3)
box((110,251,402,279),'#6cbbd0','#cdf4f8',8,4)
for x in (131,178,225,272,319,366): box((x,126,x+17,255),'#70cadc','#d2f7f8',5,3)
# Two fixed probe stems are visible independently of the mean-temperature colors.
line((99,355,79,355,79,238,66,215),'#ffd089',8)
line((415,267,435,267,435,190,451,164),'#75e0ed',8)
draw.ellipse(xy((54,195,78,219)),'#ffd089')
draw.ellipse(xy((439,143,463,167)),'#75e0ed')
# Upward heat-flow cue; no spatial temperature gradient is claimed.
line((258,109,258,62),'#efbd72',9)
draw.polygon([xy(p) for p in [(258,45),(241,70),(275,70)]],fill='#efbd72')
image=image.resize((512,512),Image.Resampling.LANCZOS)
image.save(target/'app.png')
image.save(target/'app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print('Created original Thermal Lab PNG/ICO assets.')
