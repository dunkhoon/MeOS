// 아이콘 생성기 — icons/*.png (마젠타 배경 컨택트 시트) → web/public + electron 아이콘
// 실행: npm run icons
//
// 디자이너가 준 시트는 마젠타(#FF00FF) 배경 위에 여러 크기가 라벨과 함께 배치돼 있다.
// 이 스크립트가 하는 일:
//   1) 시트에서 마젠타가 아닌 덩어리(아이콘)를 찾아 가장 큰 것을 고른다 (라벨 글자는 걸러냄)
//   2) 잘라내고, 마젠타를 투명으로 바꾼다 (경계 픽셀은 알파를 계산해 색 번짐 제거)
//   3) 용도별 크기로 리사이즈해 저장한다
//
// 시트를 새로 받으면 icons/ 에 덮어쓰고 다시 실행하면 된다.

import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'icons')
const WEB_PUBLIC = path.join(ROOT, 'web', 'public')
const ELECTRON = path.join(ROOT, 'electron')

const BG = [255, 0, 255] // 시트 배경 마젠타
const BG_TOL = 60 // 이 거리 안이면 완전한 배경으로 본다
const EDGE_TOL = 150 // 이 거리부터는 완전한 전경. 사이는 알파를 비례 배분

// ── 시트에서 아이콘 잘라내기 ────────────────────────────────

/** 배경(마젠타)으로부터의 거리 */
function bgDistance(r, g, b) {
  return Math.hypot(r - BG[0], g - BG[1], b - BG[2])
}

/**
 * 마젠타가 아닌 덩어리들의 바운딩 박스를 찾는다.
 * 라벨 글자(작고 납작함)를 걸러내기 위해 최소 크기와 정사각형 비율로 필터링한다.
 */
function findIconBoxes(data, w, h) {
  const fg = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    fg[i] = bgDistance(data[p], data[p + 1], data[p + 2]) > BG_TOL ? 1 : 0
  }

  const seen = new Uint8Array(w * h)
  const boxes = []
  const stack = new Int32Array(w * h)

  for (let start = 0; start < w * h; start++) {
    if (!fg[start] || seen[start]) continue
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let minX = w
    let maxX = 0
    let minY = h
    let maxY = 0
    let area = 0

    while (sp > 0) {
      const idx = stack[--sp]
      const x = idx % w
      const y = (idx / w) | 0
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      // 4방향 확장
      if (x > 0 && fg[idx - 1] && !seen[idx - 1]) (seen[idx - 1] = 1), (stack[sp++] = idx - 1)
      if (x < w - 1 && fg[idx + 1] && !seen[idx + 1]) (seen[idx + 1] = 1), (stack[sp++] = idx + 1)
      if (y > 0 && fg[idx - w] && !seen[idx - w]) (seen[idx - w] = 1), (stack[sp++] = idx - w)
      if (y < h - 1 && fg[idx + w] && !seen[idx + w]) (seen[idx + w] = 1), (stack[sp++] = idx + w)
    }

    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    const ratio = bw / bh
    // 아이콘: 충분히 크고 거의 정사각형. 라벨 글자는 납작하고 작아서 걸러진다
    if (bw >= 64 && bh >= 64 && ratio > 0.75 && ratio < 1.33 && area > bw * bh * 0.3) {
      boxes.push({ x: minX, y: minY, w: bw, h: bh, area })
    }
  }

  return boxes.sort((a, b) => b.w * b.h - a.w * a.h)
}

/**
 * 마젠타 배경을 투명으로. 경계의 반투명 픽셀은 배경색을 걷어내 색 번짐(fringe)을 없앤다.
 * 알파 a 로 합성된 픽셀은  P = C*a + BG*(1-a)  이므로  C = (P - BG*(1-a)) / a  로 원색을 복원한다.
 */
function chromaKey(rgb, w, h) {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0, s = 0, d = 0; i < w * h; i++, s += 3, d += 4) {
    const r = rgb[s]
    const g = rgb[s + 1]
    const b = rgb[s + 2]
    const dist = bgDistance(r, g, b)

    let a = (dist - BG_TOL) / (EDGE_TOL - BG_TOL)
    a = Math.max(0, Math.min(1, a))

    if (a <= 0) {
      out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0
      continue
    }
    if (a >= 1) {
      out[d] = r
      out[d + 1] = g
      out[d + 2] = b
      out[d + 3] = 255
      continue
    }

    // 배경 성분 제거. 알파가 작을수록 이 나눗셈이 오차를 크게 키운다
    const cr = Math.max(0, Math.min(255, Math.round((r - BG[0] * (1 - a)) / a)))
    const cg = Math.max(0, Math.min(255, Math.round((g - BG[1] * (1 - a)) / a)))
    const cb = Math.max(0, Math.min(255, Math.round((b - BG[2] * (1 - a)) / a)))

    // 걷어내고도 여전히 마젠타 계열이면 잔상(fringe)이다 → 버린다.
    // 아이콘 링의 보라색(초록 성분이 어느 정도 있음)은 이 조건에 걸리지 않는다.
    const stillMagenta = cr > 110 && cb > 110 && cg < cr * 0.7 && cg < cb * 0.7
    if (stillMagenta) {
      out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0
      continue
    }

    out[d] = cr
    out[d + 1] = cg
    out[d + 2] = cb
    out[d + 3] = Math.round(a * 255)
  }
  return out
}

/** 시트에서 가장 큰 아이콘 하나를 뽑아 투명 배경 PNG 버퍼(sharp 객체)로 돌려준다. */
async function extractLargest(sheetPath) {
  const img = sharp(sheetPath)
  const { width, height } = await img.metadata()
  const raw = await img.removeAlpha().raw().toBuffer()

  const boxes = findIconBoxes(raw, width, height)
  if (!boxes.length) throw new Error(`${path.basename(sheetPath)}: 아이콘을 찾지 못했습니다.`)
  const box = boxes[0]

  // 잘라낸 뒤 크로마키
  const cropRaw = await sharp(raw, { raw: { width, height, channels: 3 } })
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .raw()
    .toBuffer()

  const rgba = chromaKey(cropRaw, box.w, box.h)
  return {
    box,
    total: boxes.length,
    image: sharp(rgba, { raw: { width: box.w, height: box.h, channels: 4 } }),
  }
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/** 아이콘 안쪽의 배경색을 뽑는다 (링/글자를 피해 좌상단 안쪽을 표본으로). */
async function sampleBackground(src) {
  const { data, info } = await src.clone().raw().toBuffer({ resolveWithObject: true })
  const pick = (fx, fy) => {
    const x = Math.round(info.width * fx)
    const y = Math.round(info.height * fy)
    const o = (y * info.width + x) * 4
    return { r: data[o], g: data[o + 1], b: data[o + 2], a: data[o + 3] }
  }
  // 모서리 안쪽 네 곳 중 불투명한 것들의 평균
  const pts = [pick(0.2, 0.2), pick(0.8, 0.2), pick(0.2, 0.8), pick(0.8, 0.8)].filter((p) => p.a > 200)
  if (!pts.length) return { r: 13, g: 20, b: 40 }
  const avg = (k) => Math.round(pts.reduce((s, p) => s + p[k], 0) / pts.length)
  return { r: avg('r'), g: avg('g'), b: avg('b') }
}

/**
 * 정사각형으로 맞춰 저장.
 * - pad: 안쪽으로 축소할 비율
 * - bg:  캔버스를 채울 배경색. maskable 은 투명 여백이 있으면 런처가 마스크를 씌울 때
 *        아이콘이 작게 떠 보이므로, 배경을 꽉 채우고 로고만 안전영역 안에 둬야 한다.
 */
async function save(src, outPath, size, { pad = 0, bg = null } = {}) {
  const inner = Math.max(1, Math.round(size * (1 - pad * 2)))
  const off = Math.floor((size - inner) / 2)

  let pipe = src
    .clone()
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT, kernel: 'lanczos3' })

  // 여백이 있으면 테두리를 덧대 정확히 size x size 로 맞춘다
  if (size !== inner) {
    pipe = pipe.extend({
      top: off,
      bottom: size - inner - off,
      left: off,
      right: size - inner - off,
      background: bg ? { ...bg, alpha: 1 } : TRANSPARENT,
    })
  }

  // maskable: 남은 투명 영역(아이콘 모서리 등)까지 배경색으로 메워 완전 불투명하게 만든다
  if (bg) {
    const flat = await pipe.png().toBuffer()
    pipe = sharp({ create: { width: size, height: size, channels: 4, background: { ...bg, alpha: 1 } } }).composite([
      { input: flat },
    ])
  }

  // 리사이즈가 알파 낮은 가장자리 픽셀을 다시 섞어 마젠타 잔상을 되살리므로,
  // 마지막에 한 번 더 청소한다. 반투명 가장자리만 손대고 내부 디자인은 건드리지 않는다.
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H } = info
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : data[(y * W + x) * 4 + 3])
  const isMagenta = (r, g, b) => r > 110 && b > 110 && g < r * 0.6 && g < b * 0.6

  let cleaned = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      const [r, g, b, a] = [data[o], data[o + 1], data[o + 2], data[o + 3]]
      if (a === 0 || !isMagenta(r, g, b)) continue

      // 반투명이거나, 불투명이어도 투명 픽셀과 맞닿아 있으면 실루엣 경계 = 잔상.
      // 아이콘 내부 디자인은 투명과 맞닿을 일이 없어 안전하다.
      const onEdge =
        a < 250 ||
        alphaAt(x - 1, y) < 250 ||
        alphaAt(x + 1, y) < 250 ||
        alphaAt(x, y - 1) < 250 ||
        alphaAt(x, y + 1) < 250
      if (!onEdge) continue

      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0
      cleaned++
    }
  }

  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath)

  const note = [pad ? `여백 ${(pad * 100).toFixed(0)}%` : '', cleaned ? `잔상 ${cleaned}px 제거` : '']
    .filter(Boolean)
    .join(', ')
  console.log(`  ${path.relative(ROOT, outPath).padEnd(38)} ${size}x${size}${note ? `  (${note})` : ''}`)
}

// ── 실행 ────────────────────────────────────────────────────
mkdirSync(WEB_PUBLIC, { recursive: true })

const android = await extractLargest(path.join(SRC, 'android_meos_icons.png'))
const favicon = await extractLargest(path.join(SRC, 'favicon_meos.png'))
const win = await extractLargest(path.join(SRC, 'window_meos_icons.png'))

console.log(`시트에서 추출: android ${android.box.w}px · favicon ${favicon.box.w}px · window ${win.box.w}px\n`)

console.log('PWA / 안드로이드 (라운드 사각형):')
await save(android.image, path.join(WEB_PUBLIC, 'icon-192.png'), 192)
await save(android.image, path.join(WEB_PUBLIC, 'icon-512.png'), 512)
// maskable: 런처가 원형/사각 등으로 잘라낸다. 투명 여백이 있으면 아이콘이 작게 떠 보이므로
// 배경을 꽉 채운다. 링·글자는 여백 6% 에서도 안전영역(중앙 80% 원) 안에 들어오고,
// 잘려 나가는 건 사각형 모서리뿐이라 여백을 최소로 둬서 이중 프레임처럼 보이지 않게 한다.
const maskBg = await sampleBackground(android.image)
await save(android.image, path.join(WEB_PUBLIC, 'icon-maskable-512.png'), 512, { pad: 0.06, bg: maskBg })

console.log('\n브라우저 / iOS (원형):')
await save(favicon.image, path.join(WEB_PUBLIC, 'favicon-32.png'), 32)
await save(favicon.image, path.join(WEB_PUBLIC, 'apple-touch-icon.png'), 180)

console.log('\nElectron (창 / 트레이):')
await save(win.image, path.join(ELECTRON, 'tray-icon.png'), 32)
await save(win.image, path.join(ELECTRON, 'app-icon.png'), 256)

console.log('\n완료. 아이콘을 바꾸려면 icons/ 의 시트를 교체하고 다시 실행하세요.')
