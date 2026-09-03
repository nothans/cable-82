/* cable-82: the title written inside a video file, read without decoding a
   frame. Dependency-free: walks the MP4 atom tree (mp4, m4v, mov) far enough
   to find the title, in the three places the tools people use put it:
     - iTunes-style  moov/udta/meta/ilst/©nam/data   (ffmpeg -metadata title=, HandBrake, iTunes)
     - QuickTime keys moov/meta/keys + ilst, com.apple.quicktime.title   (macOS, some cameras)
     - 3GPP          moov/udta/titl                  (phones, old encoders)
   Only the headers are read; a moov atom at the end of a file is reached by
   seeking past the media, never by reading it. WebM and Ogg carry titles too
   but are not read here: they answer null and the guide uses the file name. */
"use strict";

const fs = require("node:fs");

const MOOV_CAP = 32 * 1024 * 1024; // a moov bigger than this is not a title we need

// The child atoms of buf[start, end): [{ type, start, end }] with start at
// the body. A malformed size stops the walk rather than looping.
function children(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let head = 8;
    if (len === 1 && pos + 16 <= end) {
      len = Number(buf.readBigUInt64BE(pos + 8));
      head = 16;
    } else if (len === 0) {
      len = end - pos;
    }
    if (len < head || pos + len > end) break;
    out.push({ type, start: pos + head, end: pos + len });
    pos += len;
  }
  return out;
}

function child(buf, start, end, type) {
  return children(buf, start, end).find((a) => a.type === type) || null;
}

// A `meta` atom is a full box (4 bytes of version and flags before its
// children) in the ISO layout and a plain box in QuickTime's. Tell them
// apart by where the first child's type lands.
function metaBody(buf, meta) {
  if (buf.toString("latin1", meta.start + 8, meta.start + 12) === "hdlr") return meta.start + 4;
  if (buf.toString("latin1", meta.start + 4, meta.start + 8) === "hdlr") return meta.start;
  return meta.start + 4;
}

function dataText(buf, item) {
  const data = child(buf, item.start, item.end, "data");
  if (!data || data.end - data.start < 8) return null;
  const text = buf.toString("utf8", data.start + 8, data.end).replace(/\0+$/, "").trim();
  return text || null;
}

function titleFromMoov(buf) {
  const end = buf.length;
  const udta = child(buf, 0, end, "udta");
  if (udta) {
    // iTunes-style
    const meta = child(buf, udta.start, udta.end, "meta");
    if (meta) {
      const body = metaBody(buf, meta);
      const ilst = child(buf, body, meta.end, "ilst");
      if (ilst) {
        const nam = child(buf, ilst.start, ilst.end, "\xa9nam");
        const t = nam && dataText(buf, nam);
        if (t) return t;
      }
    }
    // 3GPP titl: version/flags, 2-byte language, then the string
    const titl = child(buf, udta.start, udta.end, "titl");
    if (titl && titl.end - titl.start > 6) {
      let s = titl.start + 6;
      let text;
      if (buf[s] === 0xfe && buf[s + 1] === 0xff) {
        text = buf.subarray(s + 2, titl.end).swap16().toString("utf16le");
      } else {
        text = buf.toString("utf8", s, titl.end);
      }
      text = text.replace(/\0+$/, "").trim();
      if (text) return text;
    }
  }
  // QuickTime keys
  const meta = child(buf, 0, end, "meta");
  if (meta) {
    const body = metaBody(buf, meta);
    const keys = child(buf, body, meta.end, "keys");
    const ilst = child(buf, body, meta.end, "ilst");
    if (keys && ilst && keys.end - keys.start >= 8) {
      const count = buf.readUInt32BE(keys.start + 4);
      let pos = keys.start + 8;
      let index = 0;
      for (let i = 1; i <= count && pos + 8 <= keys.end; i++) {
        const len = buf.readUInt32BE(pos);
        if (len < 8 || pos + len > keys.end) break;
        const name = buf.toString("utf8", pos + 8, pos + len);
        if (name === "com.apple.quicktime.title") { index = i; break; }
        pos += len;
      }
      if (index) {
        const item = children(buf, ilst.start, ilst.end).find((a) => buf.readUInt32BE(a.start - 8 + 4) === index);
        const t = item && dataText(buf, item);
        if (t) return t;
      }
    }
  }
  return null;
}

// The title inside an MP4-family file, or null: no title, not an MP4, or
// unreadable. Never throws.
function readMp4Title(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(16);
    let pos = 0;
    for (let hops = 0; pos + 8 <= size && hops < 64; hops++) {
      fs.readSync(fd, hdr, 0, 16, pos);
      let len = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      let head = 8;
      if (len === 1) {
        len = Number(hdr.readBigUInt64BE(8));
        head = 16;
      } else if (len === 0) {
        len = size - pos;
      }
      if (len < head) return null;
      if (hops === 0 && type !== "ftyp" && type !== "moov" && type !== "mdat" && type !== "free" && type !== "wide") return null;
      if (type === "moov") {
        const bodyLen = len - head;
        if (bodyLen > MOOV_CAP) return null;
        const buf = Buffer.alloc(bodyLen);
        fs.readSync(fd, buf, 0, bodyLen, pos + head);
        return titleFromMoov(buf);
      }
      pos += len;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readMp4Title, titleFromMoov };
