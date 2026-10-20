# Music bed for the Sway intro: 120 bpm, A minor pad, pluck arpeggio, half-time kick from the drop (12 s),
# riser into "Until now", impacts on the scene cuts. Pure numpy, 44.1 kHz stereo WAV.
import numpy as np, wave, sys
SR = 44100; DUR = 30.0; N = int(SR * DUR)
t = np.arange(N) / SR
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)
mf = lambda m: 440.0 * 2 ** ((m - 69) / 12)

def saw(f, tt, ph=0.0, roll=4.0):
    out = np.zeros_like(tt); n = 1
    while f * n < 7000 and n <= 24:
        out += np.sin(2 * np.pi * f * n * tt + ph * n) / n * np.exp(-(n - 1) / roll); n += 1
    return out

def add(buf, start, sig):
    i = int(start * SR); j = min(N, i + len(sig))
    if i < N: buf[i:j] += sig[: j - i]

# chords: (start, end, midi notes)
CH = [(0, 4, [45, 57, 60, 64, 69]), (4, 8, [41, 57, 60, 65, 69]), (8, 10, [48, 55, 60, 64, 67]), (10, 12, [43, 55, 59, 62, 67]),
      (12, 16, [45, 57, 60, 64, 71]), (16, 20, [41, 57, 60, 65, 72]), (20, 24, [48, 55, 60, 64, 67]), (24, 26, [43, 55, 59, 62, 69]),
      (26, 30, [41, 57, 60, 65, 72])]
# pad
for (a, b, notes) in CH:
    ln = b - a + 1.6; tt = np.arange(int(ln * SR)) / SR
    env = np.minimum(1, tt / 0.9) * np.clip((ln - tt) / 1.6, 0, 1) ** 1.5
    for k, m in enumerate(notes):
        f = mf(m); amp = 0.05 if k else 0.07
        l = saw(f * 2 ** (-6 / 1200), tt, 0.3, 3.0 if k else 2.0); r = saw(f * 2 ** (6 / 1200), tt, 1.1, 3.0 if k else 2.0)
        add(L, a, l * env * amp); add(R, a, r * env * amp)
# pluck arpeggio (8ths) from 4 s to 26 s, brighter after the drop
ARP = {0: [69, 72, 76, 81], 1: [69, 72, 77, 81], 2: [67, 72, 76, 79], 3: [67, 71, 74, 79]}
def chord_at(x):
    for i, (a, b, _) in enumerate(CH):
        if a <= x < b: return i
    return len(CH) - 1
step = 0.25
for i in range(int(4 / step), int(26 / step)):
    x = i * step; c = chord_at(x); notes = CH[c][2]
    pat = ARP[[0, 1, 2, 3, 0, 1, 2, 3, 1][c]]
    m = pat[[0, 1, 2, 3, 2, 1, 2, 3][i % 8]]
    tt = np.arange(int(0.9 * SR)) / SR; f = mf(m)
    bright = 0.35 if x >= 12 else 0.18
    sig = (np.sin(2 * np.pi * f * tt) + bright * np.sin(4 * np.pi * f * tt) + 0.08 * np.sin(6 * np.pi * f * tt)) * np.exp(-tt * 7.5) * (1 - np.exp(-tt * 400))
    vol = 0.05 if x < 12 else 0.065; pan = 0.35 if i % 2 else -0.35
    add(L, x, sig * vol * (1 - pan)); add(R, x, sig * vol * (1 + pan))
# sub bass with sidechain from 12 to 26
sub = np.zeros(N)
for (a, b, notes) in CH:
    if b <= 12 or a >= 26: continue
    i0, i1 = int(max(a, 12) * SR), int(min(b, 26) * SR); tt = t[i0:i1]
    sub[i0:i1] = np.sin(2 * np.pi * mf(notes[0] - 12) * tt) * 0.16
duck = np.ones(N)
for k in np.arange(12, 26, 1.0):
    i = int(k * SR); tt = np.arange(int(0.45 * SR)) / SR; j = min(N, i + len(tt)); duck[i:j] = np.minimum(duck[i:j], 1 - 0.8 * np.exp(-tt * 9)[: j - i])
sub *= duck; L += sub; R += sub
# kick on beats 1 and 3 (every 1 s) from 12 to 26
def kick():
    tt = np.arange(int(0.5 * SR)) / SR; f = 46 + 95 * np.exp(-tt * 32); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-tt * 7) * 0.55
K = kick()
for k in np.arange(12, 26, 1.0): add(L, k, K); add(R, k, K)
# soft hats on off-beats from 16 to 26
def hat():
    n = rng.standard_normal(int(0.06 * SR)); n = np.diff(np.diff(n, prepend=0), prepend=0)
    return n * np.exp(-np.arange(len(n)) / SR * 70) * 0.03
for k in np.arange(16.25, 26, 0.5):
    h = hat(); add(L, k, h * 0.8); add(R, k, h * 1.2)
# riser 8 → 12 and impacts
ln = 4.0; tt = np.arange(int(ln * SR)) / SR
noise = rng.standard_normal(len(tt)); bright = np.diff(noise, prepend=0)
mix = (tt / ln); ris = (noise * (1 - mix) * 0.3 + bright * mix * 0.5) * (tt / ln) ** 2.5 * 0.12
sw = np.sin(2 * np.pi * np.cumsum(220 + 900 * (tt / ln) ** 2) / SR) * (tt / ln) ** 2 * 0.05
add(L, 8, ris + sw); add(R, 8, ris * 0.9 + sw)
def impact(at, v=1.0):
    tt = np.arange(int(2.2 * SR)) / SR
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-tt * 5)) / SR) * np.exp(-tt * 2.2) * 0.5
    air = rng.standard_normal(len(tt)) * np.exp(-tt * 3.5) * 0.06
    add(L, at, (boom + air) * v); add(R, at, (boom + air * 0.8) * v)
impact(12.0); impact(26.0, 0.8); impact(0.25, 0.55)
# whooshes into scene cuts
for at in (3.6, 7.6, 15.6, 21.6):
    tt = np.arange(int(0.5 * SR)) / SR; n = rng.standard_normal(len(tt)); n = np.diff(n, prepend=0) * 0.5 + n * 0.5
    env = np.sin(np.pi * tt / 0.5) ** 2 * 0.05; add(L, at, n * env); add(R, at, n * env * 0.9)
# reverb (stereo exponential noise IR via FFT)
def reverb(x, seed):
    g = np.random.default_rng(seed); ln = int(2.6 * SR); ir = g.standard_normal(ln) * np.exp(-np.arange(ln) / SR * 2.4); ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
    ir /= np.sqrt((ir ** 2).sum()); n2 = 1 << int(np.ceil(np.log2(len(x) + ln)))
    return np.fft.irfft(np.fft.rfft(x, n2) * np.fft.rfft(ir, n2), n2)[: len(x)]
L = L + 0.28 * reverb(L, 1); R = R + 0.28 * reverb(R, 2)
# master
fade = np.ones(N); fo = int(2.0 * SR); fade[-fo:] = np.linspace(1, 0, fo) ** 1.5; fade[: int(0.02 * SR)] = np.linspace(0, 1, int(0.02 * SR))
L *= fade; R *= fade
pk = max(np.abs(L).max(), np.abs(R).max()); L = np.tanh(L / pk * 1.2) / np.tanh(1.2) * 0.89; R = np.tanh(R / pk * 1.2) / np.tanh(1.2) * 0.89
st = (np.stack([L, R], 1) * 32767).astype('<i2')
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
print('ok', st.shape)
