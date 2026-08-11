// electron/app-icon.png → electron/build/icon.ico (설치본·exe·작업표시줄 아이콘)
//
// sharp 는 .ico 를 못 쓰므로 컨테이너를 직접 만든다. Vista 이후 Windows 는
// ICO 안에 PNG 를 그대로 넣는 것을 지원하므로 크기별 PNG 를 담기만 하면 된다.
//   ICONDIR      : reserved(2)=0, type(2)=1, count(2)
//   ICONDIRENTRY : w(1), h(1), colors(1), reserved(1), planes(2), bpp(2), size(4), offset(4)
//                  ※ 256px 은 1바이트에 안 들어가므로 0 으로 적는다

import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'electron', 'app-icon.png')
const OUT_DIR = path.join(ROOT, 'electron', 'build')
const OUT = path.join(OUT_DIR, 'icon.ico')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

const pngs = await Promise.all(
  SIZES.map((s) => sharp(SRC).resize(s, s, { kernel: 'lanczos3', fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer()),
)

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // 1 = icon
header.writeUInt16LE(SIZES.length, 4)

const entries = []
let offset = 6 + SIZES.length * 16
SIZES.forEach((size, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(size >= 256 ? 0 : size, 0)
  e.writeUInt8(size >= 256 ? 0 : size, 1)
  e.writeUInt8(0, 2) // 팔레트 없음
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // color planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  entries.push(e)
})

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs]))
console.log(`✓ ${path.relative(ROOT, OUT)} — ${SIZES.join('/')}px, ${(offset / 1024).toFixed(1)}KB`)
