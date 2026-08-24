// 클립보드에 있는 이미지를 꺼낸다.
//
// 영양정보표는 대개 **화면을 캡처한 것**이다(쇼핑몰 상세페이지, 카톡으로 받은 사진).
// 그걸 파일로 저장한 뒤 다시 고르게 하면 두 단계가 헛돈다 — 붙여넣기로 바로 받는다.
//
// 길이 둘이고 둘 다 필요하다.
//   · **paste 이벤트**(Ctrl+V) — 권한이 필요 없고 어디서나 된다. 기본 길.
//   · **navigator.clipboard.read()** — 버튼으로 부를 때. 사용자 제스처 + 권한이 필요하고
//     브라우저·플랫폼에 따라 막힌다. 그래서 실패를 오류가 아니라 **정상 흐름**으로 다룬다
//     (버튼이 안 되면 Ctrl+V 로 안내한다).

/** 업로드 경로의 확장자로 쓸 수 있는 것만. 여기 없으면 이미지로 취급하지 않는다. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

export function isImageType(type: string | undefined | null): boolean {
  return !!EXT_BY_TYPE[String(type || '').toLowerCase()]
}

/** MIME → 확장자. 모르는 형식이면 png (Chromium 이 캡처를 png 로 준다). */
export function imageExt(type: string | undefined | null): string {
  return EXT_BY_TYPE[String(type || '').toLowerCase()] || 'png'
}

/**
 * paste 이벤트에서 이미지를 꺼낸다. 없으면 null —
 * ⚠️ null 일 때 이벤트를 **막지 말아야 한다**. 글자 붙여넣기가 같은 이벤트로 온다.
 */
export function imageFromPaste(e: ClipboardEvent): File | null {
  const items = e.clipboardData?.items
  if (!items) return null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'file') continue
    const f = it.getAsFile()
    if (f && isImageType(f.type)) return f
  }
  return null
}

/**
 * 버튼용 클립보드 읽기. 안 되는 이유를 문장으로 돌려준다(권한 거부는 흔한 일이다).
 * 반드시 클릭 핸들러 안에서 불러야 한다 — 사용자 제스처가 없으면 브라우저가 거절한다.
 */
export async function readClipboardImage(): Promise<{ file: File | null; error?: string }> {
  if (!navigator.clipboard?.read) {
    return { file: null, error: '이 브라우저는 클립보드 읽기를 지원하지 않습니다 — Ctrl+V 로 붙여넣어 주세요.' }
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(isImageType)
      if (!type) continue
      const blob = await item.getType(type)
      return { file: new File([blob], `clipboard.${imageExt(type)}`, { type }) }
    }
    return { file: null, error: '클립보드에 이미지가 없습니다. 캡처한 뒤 다시 눌러 주세요.' }
  } catch {
    // 권한 거부 · 포커스 없음 · 정책 차단이 전부 여기로 온다. 구분해 봐야 할 일이 같다.
    return { file: null, error: '클립보드를 읽지 못했습니다 — Ctrl+V 로 붙여넣어 주세요.' }
  }
}
