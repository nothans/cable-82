"""Build a minimal 256-byte EDID: 640x480@60 preferred, HDMI sink with 2-channel LPCM audio.
For HDMI-to-RF/composite converters that present no EDID, so the Pi's vc4 driver enables audio
and picks a 4:3 mode. Output: cable82-640x480-audio.bin"""
import os
import struct


def pnp_id(s):  # 3 uppercase letters -> 2 bytes, big-endian 5-bit packed
    v = 0
    for ch in s:
        v = (v << 5) | (ord(ch) - 64)
    return struct.pack(">H", v)


def descriptor(tag, payload):  # 18-byte display descriptor
    d = (b"\x00\x00\x00" + bytes([tag]) + b"\x00" + payload).ljust(18, b" ")
    assert len(d) == 18, len(d)
    return d


# DTD: 640x480@59.94, pixel clock 25.18 MHz, hblank 160, vblank 45, hsync 16/96, vsync 10/2
dtd = bytearray(18)
struct.pack_into("<H", dtd, 0, 2518)
dtd[2] = 640 & 0xFF; dtd[3] = 160 & 0xFF; dtd[4] = ((640 >> 8) << 4) | (160 >> 8)
dtd[5] = 480 & 0xFF; dtd[6] = 45 & 0xFF; dtd[7] = ((480 >> 8) << 4) | (45 >> 8)
dtd[8] = 16; dtd[9] = 96; dtd[10] = (10 << 4) | 2; dtd[11] = 0
dtd[12] = 160 & 0xFF; dtd[13] = 120 & 0xFF; dtd[14] = ((160 >> 8) << 4) | (120 >> 8)
dtd[15] = 0; dtd[16] = 0; dtd[17] = 0x18  # digital separate sync, negative/negative
dtd = bytes(dtd)

base = bytearray()
base += b"\x00\xff\xff\xff\xff\xff\xff\x00"   # header
base += pnp_id("CBL")                          # manufacturer
base += struct.pack("<H", 0x0082)              # product code
base += struct.pack("<I", 0)                   # serial (string descriptor carries it)
base += bytes([1, 2026 - 1990])                # week, year
base += bytes([1, 3])                          # EDID 1.3
base += bytes([0x80])                          # digital input
base += bytes([16, 12])                        # 16 x 12 cm
base += bytes([120])                           # gamma 2.2
base += bytes([0x0E])                          # RGB, sRGB, preferred timing in DTD 1
base += bytes([0xEE, 0x91, 0xA3, 0x54, 0x4C, 0x99, 0x26, 0x0F, 0x50, 0x54])  # chromaticity
base += bytes([0x20, 0x00, 0x00])              # established timings: 640x480@60 only
base += b"\x01" * 16                           # standard timings: unused
base += dtd                                    # DTD 1 (preferred)
base += descriptor(0xFC, b"CABLE 82\n")        # monitor name
base += descriptor(0xFD, bytes([50, 75, 30, 35, 3, 0x00, 0x0A]))  # range limits, default GTF
base += descriptor(0xFF, b"1982\n")            # serial string
base += bytes([1])                             # one extension block
assert len(base) == 127, len(base)
base += bytes([(-sum(base)) & 0xFF])

blocks = bytearray()
blocks += bytes([(2 << 5) | 2, 1, 2])                  # Video DB: VIC 1 (640x480p), VIC 2 (720x480p 4:3)
blocks += bytes([(1 << 5) | 3, 0x09, 0x07, 0x07])      # Audio DB: LPCM 2ch, 48/44.1/32 kHz, 24/20/16-bit
blocks += bytes([(4 << 5) | 3, 0x01, 0x00, 0x00])      # Speaker allocation: FL/FR
blocks += bytes([(3 << 5) | 5, 0x03, 0x0C, 0x00, 0x10, 0x00])  # HDMI VSDB, phys addr 1.0.0.0
blocks += bytes([(7 << 5) | 2, 0x00, 0x40])            # Video Capability DB: selectable RGB quantization

ext = bytearray()
ext += bytes([0x02, 0x03])                     # CTA-861 rev 3
ext += bytes([4 + len(blocks)])                # DTD offset
ext += bytes([0xC0])                           # underscan + basic audio
ext += blocks
ext += dtd
ext = ext.ljust(127, b"\x00")
assert len(ext) == 127, len(ext)
ext += bytes([(-sum(ext)) & 0xFF])

out = bytes(base + ext)
assert len(out) == 256 and sum(out[:128]) % 256 == 0 and sum(out[128:]) % 256 == 0
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cable82-640x480-audio.bin"), "wb").write(out)
print("wrote cable82-640x480-audio.bin", len(out), "bytes")
