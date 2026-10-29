# Искусственный кадр для tests/beauty.test.mjs: «кожа» с шумом, тёмная полоска (граница черт лица),
# желтоватые «зубы» среди кожи и такой же желтоватый «кусок стены» на синем фоне.
# Запуск: python3 tests/make-skin-y4m.py  →  ~/.svoi-test/skin.y4m (песочница Chrome не читает папку проекта)
import os
import random

W, H = 640, 480
random.seed(7)


def ycc(r, g, b):
    return (0.299 * r + 0.587 * g + 0.114 * b,
            128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
            128 + 0.5 * r - 0.418688 * g - 0.081312 * b)


SKIN, BLUE, TEETH, DARK = ycc(224, 172, 140), ycc(80, 100, 140), ycc(230, 220, 190), ycc(60, 40, 35)


def px(x, y):
    if 300 <= y < 330 and (300 <= x < 360 or 540 <= x < 600):
        return TEETH, 0
    if x >= 480:
        return BLUE, 0
    if 200 <= x < 206:
        return DARK, 0
    return SKIN, 12


Y = bytearray(W * H)
U = bytearray((W // 2) * (H // 2))
V = bytearray((W // 2) * (H // 2))
for y in range(H):
    for x in range(W):
        (yy, _, _), noise = px(x, y)
        Y[y * W + x] = max(0, min(255, int(yy + (random.gauss(0, noise) if noise else 0))))
for y in range(H // 2):
    for x in range(W // 2):
        (_, cb, cr), _ = px(x * 2, y * 2)
        U[y * (W // 2) + x] = int(cb)
        V[y * (W // 2) + x] = int(cr)

path = os.path.expanduser('~/.svoi-test/skin.y4m')
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'wb') as f:
    f.write(b'YUV4MPEG2 W640 H480 F30:1 Ip A1:1 C420jpeg\n')
    for _ in range(2):
        f.write(b'FRAME\n' + Y + U + V)
print(path)
