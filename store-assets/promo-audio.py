"""Soundtracks for the promo videos: a soft synth bed plus UI sound effects.

Everything is synthesized, so there is nothing to license. Cue times mirror
the timings in promo-video.tsx ("video"), promo-lineup.tsx ("lineup") and
promo-showcase.tsx ("showcase");
update both together.

    python3 store-assets/promo-audio.py out.wav [video|lineup|showcase]
"""
import math
import random
import struct
import sys
import wave

RATE = 44100
VIDEO = sys.argv[2] if len(sys.argv) > 2 else "video"
DURATION = {"video": 44.5, "lineup": 40.0, "showcase": 47.5}[VIDEO]
N = int(RATE * DURATION)
L = [0.0] * N
R = [0.0] * N
random.seed(7)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def add(start, samples, gain=1.0, pan=0.0):
    """Mix a mono buffer into the stereo track at `start` seconds."""
    i0 = int(start * RATE)
    gl, gr = gain * (1 - max(0, pan)), gain * (1 + min(0, pan))
    for k, v in enumerate(samples):
        i = i0 + k
        if 0 <= i < N:
            L[i] += v * gl
            R[i] += v * gr


def tone(freqs, dur, attack=0.01, decay=None, release=0.05, harmonics=(1.0,), detune=0.0):
    n = int(dur * RATE)
    out = [0.0] * n
    for f in freqs:
        for h, amp in enumerate(harmonics, start=1):
            for d in ((0.0,) if not detune else (-detune, detune)):
                w = 2 * math.pi * f * h * (1 + d) / RATE
                ph = random.random() * 6.28
                for k in range(n):
                    out[k] += amp * math.sin(ph + w * k)
    norm = 1.0 / max(1, len(freqs) * (2 if detune else 1))
    for k in range(n):
        t = k / RATE
        env = min(1.0, t / attack) if attack else 1.0
        if decay:
            env *= math.exp(-t / decay)
        env *= min(1.0, (dur - t) / release) if release else 1.0
        out[k] *= env * norm
    return out


def noise(dur, lp=0.2):
    """Low-passed noise (one-pole), lp in (0, 1]: smaller is darker."""
    n = int(dur * RATE)
    out, y = [0.0] * n, 0.0
    for k in range(n):
        y += lp * (random.uniform(-1, 1) - y)
        out[k] = y
    return out


# ---- Music bed ---------------------------------------------------------------


def music(bpm, chords, groove_from, rests, groove_to, end, arp_pattern, pad_gain=0.16):
    beat_len = 60 / bpm
    chord_len = 8 * beat_len  # two bars per chord
    t, ci = 0.0, 0
    while t < end:
        chord = chords[ci % len(chords)]
        dur = min(chord_len + 0.6, DURATION - t)
        add(t, tone([midi(n) for n in chord], dur, attack=0.8, release=0.9, harmonics=(1.0, 0.25), detune=0.002), gain=pad_gain)
        add(t, tone([midi(chord[0] - 12)], dur, attack=0.4, release=0.6), gain=0.10)
        for step in range(16):
            at = t + step * beat_len / 2
            if at < groove_from or at >= end or any(a <= at < b for a, b in rests):
                continue
            note = chord[arp_pattern[step % len(arp_pattern)]] + 12
            add(at, tone([midi(note)], 0.5, attack=0.004, decay=0.16, harmonics=(1.0, 0.3, 0.1)), gain=0.07, pan=0.3 if step % 2 else -0.3)
        t += chord_len
        ci += 1
    beat = groove_from + 0.2
    while beat < groove_to:
        if round((beat - groove_from) / beat_len) % 2 == 0:
            kick(beat)
        shaker(beat + beat_len / 2)
        beat += beat_len


def kick(at):
    n = int(0.35 * RATE)
    out, ph = [0.0] * n, 0.0
    for k in range(n):
        tt = k / RATE
        ph += 2 * math.pi * (45 + 90 * math.exp(-tt / 0.03)) / RATE
        out[k] = math.sin(ph) * math.exp(-tt / 0.09)
    add(at, out, gain=0.22)


def shaker(at):
    s = noise(0.07, lp=0.9)
    add(at, [v * math.exp(-k / RATE / 0.02) for k, v in enumerate(s)], gain=0.035, pan=0.2)


# ---- Sound effects -------------------------------------------------------------


def whoosh(at, dur=0.55, gain=0.12):
    s = noise(dur, lp=0.12)
    add(at, [v * math.sin(math.pi * k / len(s)) ** 2 for k, v in enumerate(s)], gain=gain)


def pop(at, gain=0.35):
    n = int(0.18 * RATE)
    out, ph = [0.0] * n, 0.0
    for k in range(n):
        tt = k / RATE
        ph += 2 * math.pi * (380 + 700 * math.exp(-tt / 0.025)) / RATE
        out[k] = math.sin(ph) * math.exp(-tt / 0.05)
    add(at, out, gain=gain)


def key(at, gain=0.5):
    click = noise(0.03, lp=0.7)
    add(at, [v * math.exp(-k / RATE / 0.006) for k, v in enumerate(click)], gain=gain)
    add(at, tone([140], 0.06, attack=0.001, decay=0.015), gain=gain * 0.8)


def tap(at, gain=0.3):
    add(at, tone([1800], 0.05, attack=0.001, decay=0.01), gain=gain)


def chime(at, notes=(76, 83), gain=0.22):
    for i, n in enumerate(notes):
        add(at + i * 0.09, tone([midi(n)], 0.9, attack=0.003, decay=0.28, harmonics=(1.0, 0.4, 0.15)), gain=gain)


def ding(at):
    chime(at, (79, 84, 88), gain=0.2)


def data_trail(start, end, gain=0.05, pan=0.0):
    """Quick digital blips while a scrambled card is in flight."""
    at, i = start + 0.15, 0
    while at < end - 0.15:
        add(at, tone([midi(96 + (i * 7) % 12)], 0.04, attack=0.001, decay=0.012), gain=gain, pan=pan)
        at += 0.075
        i += 1


def land(at, gain=0.18):
    """Soft thump + sparkle when a card arrives and unscrambles."""
    add(at, tone([midi(52)], 0.25, attack=0.002, decay=0.07), gain=gain * 1.4)
    chime(at + 0.02, (88,), gain=gain * 0.6)


if VIDEO == "video":
    music(100, [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [41, 48, 52, 55, 57], [43, 50, 55, 59, 64]],
          groove_from=8.4, rests=[(37.4, 40.8)], groove_to=37.4, end=43.2, arp_pattern=[1, 2, 3, 4, 3, 2])
    # Scene changes (promo-video.tsx T): intro → hook → origin → features → privacy → outro
    for at in (2.45, 4.85, 8.45, 13.45, 17.65, 23.65, 28.65, 32.85, 37.45):
        whoosh(at)
    pop(0.12)
    whoosh(0.95, 0.6, 0.08)
    key(11.4)                 # ⌘C on Work MacBook
    key(11.43, 0.35)
    chime(11.6, (79, 86))     # Copyyt icon pulse: sent
    key(15.2)                 # Ctrl V on Home PC
    key(15.23, 0.35)
    ding(18.7)                # Android notification
    tap(20.7)                 # long press
    tap(21.7)                 # Paste
    tap(25.6)                 # Send my clipboard
    chime(26.3)               # Sent to 2 device(s)
    tap(30.8)                 # Copy image
    chime(30.95, (81, 88))    # Image copied
    tap(35.2)                 # Home tab
    tap(36.3)                 # Receive only
    pop(40.9, 0.3)            # Outro logo
    chime(41.1, (72, 79, 84, 88), gain=0.16)
elif VIDEO == "showcase":
    # Same warm bed as "video"; the groove starts with the first demo and rests for privacy.
    music(100, [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [41, 48, 52, 55, 57], [43, 50, 55, 59, 64]],
          groove_from=10.4, rests=[(38.6, 43.2)], groove_to=38.6, end=46.2, arp_pattern=[1, 2, 3, 4, 3, 2])
    for at in (0.3, 1.5, 2.6):                # opening lines appear
        pop(at, 0.14)
    whoosh(3.7, 0.4, 0.06)                    # strike-through
    pop(4.3, 0.25)                            # "Not anymore."
    chime(4.35, (79, 86), gain=0.14)
    tap(6.0, 0.2)                             # iPhone + Mac card
    tap(6.5, 0.2)                             # Android + laptops card
    chime(8.2, (76, 83, 88), gain=0.18)       # Copyyt arrives
    for at in (10.45, 15.25, 19.45, 25.05, 29.85, 34.05, 38.65, 43.05):
        whoosh(at, 0.45, 0.06)                # sideways scene slides
    key(13.4)                                 # ⌘C
    key(13.43, 0.35)
    chime(13.6, (79, 86))                     # sent
    key(17.0)                                 # Ctrl V
    key(17.03, 0.35)
    ding(20.5)                                # Android notification
    tap(22.5)                                 # long press
    tap(23.5)                                 # Paste
    tap(27.0)                                 # Send my clipboard
    chime(27.7)                               # Sent to 2 device(s)
    tap(32.0)                                 # Copy image
    chime(32.15, (81, 88))                    # Image copied
    tap(36.4)                                 # Home tab
    tap(37.5)                                 # Receive only
    for i, at in enumerate((39.5, 39.75, 40.0)):  # privacy cards
        pop(at, 0.12 + 0.02 * i)
    pop(43.4, 0.3)                            # outro
    chime(43.6, (72, 79, 84, 88), gain=0.16)
else:
    # Darker, slower bed in D minor: Dm9 – Bbmaj7 – Gm9 – A7sus
    music(88, [[50, 57, 60, 64, 65], [46, 53, 57, 60, 62], [43, 50, 53, 57, 58], [45, 52, 55, 59, 62]],
          groove_from=7.2, rests=[], groove_to=35.2, end=38.6, arp_pattern=[1, 3, 2, 4, 2, 3, 1, 4], pad_gain=0.18)
    # Camera moves (promo-lineup.tsx SHOTS) get a soft air swell.
    for at in (7.0, 9.9, 11.1, 13.4, 19.4, 21.8, 24.3, 30.8, 34.6):
        whoosh(at, 0.8, 0.07)
    for i, at in enumerate((0.25, 0.55, 0.85)):  # devices draw in
        chime(at, (74 + i * 5,), gain=0.12)
    key(9.6)                              # ⌘C
    key(9.63, 0.35)
    data_trail(9.8, 11.3, pan=-0.2)       # to Home PC and the phone
    land(11.3)
    ding(11.45)                           # phone notification
    tap(15.4)                             # long press
    tap(16.3)                             # Paste
    tap(19.8)                             # Send my clipboard
    data_trail(20.1, 21.7, pan=0.3)
    land(21.7)
    chime(20.35, (79, 86), gain=0.15)     # Sent to 2 device(s)
    tap(23.4)                             # Copy image
    chime(23.55, (81, 88))                # Image copied
    data_trail(25.6, 27.2, gain=0.06)     # up to the server
    add(27.2, tone([midi(38)], 1.7, attack=0.2, release=0.4, harmonics=(1.0, 0.5)), gain=0.08)  # server hum
    data_trail(28.9, 30.3, gain=0.06)
    land(30.3)
    tap(32.3)                             # Paused
    add(32.35, tone([midi(64), midi(59)], 0.5, attack=0.005, decay=0.15), gain=0.12)  # soft "off" dyad
    whoosh(35.4, 0.9, 0.1)                # card flies to centre
    pop(36.35, 0.3)                       # splits into the logo
    chime(36.9, (74, 81, 86, 89), gain=0.16)

# ---- Master: fade, soft clip, write -------------------------------------------------
peak = max(max(abs(v) for v in L), max(abs(v) for v in R))
scale = 0.9 / peak
fade_in, fade_out = int(0.05 * RATE), int(1.6 * RATE)
frames = bytearray()
for i in range(N):
    g = scale * min(1.0, i / fade_in) * min(1.0, (N - i) / fade_out)
    frames += struct.pack("<hh", int(math.tanh(L[i] * g) * 32000), int(math.tanh(R[i] * g) * 32000))
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(bytes(frames))
print(sys.argv[1])
