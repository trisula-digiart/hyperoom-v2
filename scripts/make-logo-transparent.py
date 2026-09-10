from PIL import Image
import numpy as np

img = Image.open(r"H:\TRISULA_DIGIART\hyperoom-v2\logo.jpg").convert("RGBA")
data = np.array(img)

# White background -> transparent with sharp edge (keep content opaque)
r = data[:, :, 0].astype(float)
g = data[:, :, 1].astype(float)
b = data[:, :, 2].astype(float)
# min channel: if all channels near-white -> transparent
imin = np.minimum(np.minimum(r, g), b)
# sharp: >= 250 fully transparent, 240-250 gradient, <240 fully opaque
alpha = np.clip((255 - (imin - 240) * 25.5), 0, 255).astype(np.uint8)
data[:, :, 3] = alpha

out = Image.fromarray(data)
out.save(r"H:\TRISULA_DIGIART\hyperoom-v2\logo-transparent.png")
print("saved", out.size)