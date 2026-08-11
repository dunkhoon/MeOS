// 트레이 아이콘(PNG) 생성기 — electron/tray-icon.png (32x32, accent 색 원형)
// 실행: node scripts/make-tray-icon.mjs
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'electron', 'tray-icon.png')

const W = 32
const H = 32
const ACCENT = [255, 107, 53, 255]
const CLEAR = [0, 0, 0, 0]

// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

// 픽셀: 중심 원
const cx = 16
const cy = 16
const R = 14
const raw = Buffer.alloc(H * (1 + W * 4))
let o = 0
for (let y = 0; y < H; y++) {
  raw[o++] = 0 // filter: none
  for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - cx
    const dy = y + 0.5 - cy
    const p = dx * dx + dy * dy <= R * R ? ACCENT : CLEAR
    raw[o++] = p[0]
    raw[o++] = p[1]
    raw[o++] = p[2]
    raw[o++] = p[3]
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
writeFileSync(OUT, png)
console.log('wrote', OUT, png.length, 'bytes')
