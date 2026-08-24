import { useEffect, useRef, useState } from 'react'
import { errMsg } from '../../lib/exercise'
import { isBadNum, numText, parseNum } from '../../lib/num'
import {
  COMMON_UNITS,
  NUTRIENTS,
  NUTRIENT_LABEL,
  NUTRIENT_UNIT,
  saveFood,
  type Food,
  type FoodInput,
  type Nutrient,
} from '../../lib/food'
import { askFoodParse, parseFoodReply, photoPrompt, pollReply, textPrompt, uploadLabelPhoto } from '../../lib/foodAi'
import { imageFromPaste, readClipboardImage } from '../../lib/clipboardImage'

// 음식 등록·편집. AI 가 읽은 결과도 **여기에 채워 놓고** 사람이 확인한 뒤 저장한다.
// 잘못 읽은 숫자가 그대로 합계에 들어가지 않게 하려는 것이다.
//
// ⚠️ 숫자 칸은 **문자열로 들고 있는다.** 파싱한 숫자를 value 로 되돌리면 소수점을 못 찍고
//    (`"0."` → 0 → 칸이 "0" 으로 다시 그려짐), 잘못된 글자를 치면 "NaN" 이 박혀 고칠 수도 없다.
//    자세한 이유는 `lib/num.ts` 참고.

const POLL_MS = 2500

/** 표에 자주 있는 것만 위로. 나머지는 접어 둔다 — 입력 칸이 11개면 질린다. */
const MAIN: Nutrient[] = ['kcal', 'carb_g', 'protein_g', 'fat_g']
const MORE: Nutrient[] = NUTRIENTS.filter((n) => !MAIN.includes(n))

/** 편집 중 상태 — 숫자 칸은 전부 문자열이다 */
type Draft = {
  name: string
  brand: string
  base_amount: string
  base_unit: string
  base_grams: string
  source: string
  note: string | null
} & Record<Nutrient, string>

function toDraft(f?: Food | Partial<FoodInput>): Draft {
  const d = {
    name: f?.name ?? '',
    brand: f?.brand ?? '',
    base_amount: numText(f?.base_amount ?? 100),
    base_unit: f?.base_unit ?? 'g',
    base_grams: numText(f?.base_grams),
    source: f?.source ?? 'manual',
    note: f?.note ?? null,
  } as Draft
  for (const n of NUTRIENTS) d[n] = numText(f?.[n])
  return d
}

export function FoodEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Food
  onSaved: (f: Food) => void
  onCancel: () => void
}) {
  const [d, setD] = useState<Draft>(() => toDraft(initial))
  const [showMore, setShowMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── AI 로 채우기 ──
  const [aiOpen, setAiOpen] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiState, setAiState] = useState<'idle' | 'uploading' | 'waiting'>('idle')
  const [aiNote, setAiNote] = useState<string | null>(null)
  /** 방금 보낸 사진 미리보기(objectURL). 붙여넣기는 눈에 안 보이니 **무엇이 갔는지** 보여 줘야 한다. */
  const [shot, setShot] = useState<string | null>(null)
  const [shotBig, setShotBig] = useState(false)
  const shotUrl = useRef<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pending = useRef<{ threadId: string; messageId: string } | null>(null)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }))

  // 잘못된 글자가 들어간 칸들 — 저장을 막고 어디가 문제인지 보여 준다
  const badFields = ([...NUTRIENTS, 'base_amount', 'base_grams'] as const).filter((k) => isBadNum(d[k]))
  const amount = parseNum(d.base_amount)
  const canSave = d.name.trim() !== '' && badFields.length === 0 && amount != null && amount > 0

  useEffect(() => {
    if (aiState !== 'waiting' || !pending.current) return
    const id = window.setInterval(() => {
      const p = pending.current
      if (!p) return
      void pollReply(p.threadId, p.messageId).then((r) => {
        if (r.failed) {
          setAiState('idle')
          pending.current = null
          setAiNote(null)
          setError(`AI 분석 실패: ${r.failed}`)
          return
        }
        if (!r.done || !r.reply) return
        setAiState('idle')
        pending.current = null
        const parsed = parseFoodReply(r.reply.content)
        if (!parsed.ok || !parsed.food) {
          setAiNote(null)
          setError(`AI 답을 읽지 못했습니다 (${parsed.error}). 어시스턴트 탭에서 원문을 볼 수 있습니다.`)
          return
        }
        // 사람이 고칠 수 있게 채워만 둔다 — 저장은 아래 버튼으로
        setD((prev) => ({ ...toDraft({ ...parsed.food }), source: prev.source === 'manual' ? 'ai-photo' : prev.source }))
        setAiOpen(false)
        setAiNote('AI 가 채웠습니다. 숫자를 확인하고 저장하세요.')
      })
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [aiState])

  async function runPhoto(file: Blob) {
    setError(null)
    setAiNote(null)
    // 보낸 것을 화면에 남긴다 — AI 가 채운 숫자를 표와 대조할 때도 이게 있어야 한다
    if (shotUrl.current) URL.revokeObjectURL(shotUrl.current)
    shotUrl.current = URL.createObjectURL(file)
    setShot(shotUrl.current)
    setShotBig(false)
    setAiState('uploading')
    try {
      const { signedUrl } = await uploadLabelPhoto(file)
      pending.current = await askFoodParse(photoPrompt(signedUrl))
      set('source', 'ai-photo')
      setAiState('waiting')
    } catch (e) {
      setAiState('idle')
      setError(errMsg(e))
    }
  }

  /**
   * Ctrl+V. AI 칸이 펼쳐져 있을 때만 듣는다 —
   * 항상 듣고 있으면 다른 목적으로 복사한 이미지를 이름 칸에서 붙여넣었을 때
   * 30초짜리 분석이 멋대로 시작된다.
   *
   * ⚠️ 이미지가 없으면 이벤트를 그대로 흘려보낸다(설명 칸에 글자를 붙여넣어야 한다).
   */
  useEffect(() => {
    if (!aiOpen || aiState !== 'idle') return
    const onPaste = (e: ClipboardEvent) => {
      const img = imageFromPaste(e)
      if (!img) return
      e.preventDefault()
      void runPhoto(img)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOpen, aiState])

  /** 버튼으로 클립보드 읽기 — 권한이 막히는 환경이 있어 실패하면 Ctrl+V 로 안내한다. */
  async function runClipboard() {
    setError(null)
    const { file, error: why } = await readClipboardImage()
    if (!file) {
      setAiNote(why ?? '클립보드에 이미지가 없습니다.')
      return
    }
    await runPhoto(file)
  }

  // 미리보기 objectURL 은 창이 닫힐 때 돌려준다 (상태가 아니라 ref 로 붙잡는다 —
  // 정리 함수 안에서는 setState 로 값을 꺼낼 수 없다)
  useEffect(() => () => {
    if (shotUrl.current) URL.revokeObjectURL(shotUrl.current)
  }, [])

  async function runText() {
    if (!aiText.trim()) return
    setError(null)
    setAiState('uploading')
    try {
      pending.current = await askFoodParse(textPrompt(aiText.trim()))
      set('source', 'ai-text')
      setAiState('waiting')
    } catch (e) {
      setAiState('idle')
      setError(errMsg(e))
    }
  }

  async function submit() {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const input: FoodInput = {
        name: d.name.trim(),
        brand: d.brand.trim() || null,
        base_amount: (parseNum(d.base_amount) as number) ?? 100,
        base_unit: d.base_unit.trim() || 'g',
        base_grams: (parseNum(d.base_grams) as number | null) ?? null,
        source: d.source,
        note: d.note,
      }
      for (const n of NUTRIENTS) input[n] = (parseNum(d[n]) as number | null) ?? null
      onSaved(await saveFood(input, initial?.id))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const waiting = aiState !== 'idle'
  const grams = parseNum(d.base_grams)

  return (
    <div className="fd-editor">
      <div className="fd-editor-head">
        <h3 className="card-title">{initial ? '음식 수정' : '음식 등록'}</h3>
        <button className="link-btn small" onClick={onCancel}>
          닫기
        </button>
      </div>

      {!initial && (
        <div className="fd-ai">
          <button className="ask-btn" onClick={() => setAiOpen((v) => !v)} disabled={waiting}>
            ✦ AI 로 채우기
          </button>
          {waiting && (
            <span className="muted small">
              <span className="spinner" /> {aiState === 'uploading' ? '보내는 중…' : '집 PC 가 읽는 중…'}
            </span>
          )}
          {aiNote && !waiting && <span className="muted small">{aiNote}</span>}
          {/* 보낸 사진 — 눌러서 키운다. 채워진 숫자를 표와 대조할 때 필요하다 */}
          {shot && (
            <button
              type="button"
              className={`fd-shot ${shotBig ? 'big' : ''}`}
              onClick={() => setShotBig((v) => !v)}
              title={shotBig ? '접기' : '크게 보기'}
            >
              <img src={shot} alt="AI 에게 보낸 영양정보표" />
            </button>
          )}
        </div>
      )}

      {aiOpen && !waiting && (
        <div className="fd-ai-body">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void runPhoto(file)
              e.target.value = ''
            }}
          />
          <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
            📷 사진 고르기
          </button>
          <button className="ghost-btn" onClick={() => void runClipboard()} title="캡처한 이미지를 클립보드에서 바로 읽습니다">
            📋 클립보드에서
          </button>
          <span className="muted small">또는</span>
          <input
            className="em-input"
            placeholder="먹은 걸 설명 (예: 크림 파스타 1인분, 면 150g)"
            value={aiText}
            onChange={(e) => setAiText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runText()}
          />
          <button className="ghost-btn" disabled={!aiText.trim()} onClick={() => void runText()}>
            추정
          </button>
          <p className="muted small fd-ai-hint">
            여기서 <b>Ctrl+V</b> 로 캡처를 바로 붙여넣을 수 있습니다(Win+Shift+S 로 잘라내 오면 됩니다).
            <br />
            사진은 <b>음식 사진이 아니라 영양정보표</b>를 찍은 것이어야 합니다. 집 PC 의 OpenClaw 가 읽습니다.
          </p>
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      <div className="fd-row">
        <label className="bn-field fd-grow">
          <span className="muted small">음식 이름</span>
          <input className="em-input" value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="닭가슴살 스테이크" />
        </label>
        <label className="bn-field">
          <span className="muted small">브랜드</span>
          <input className="em-input" value={d.brand} onChange={(e) => set('brand', e.target.value)} placeholder="맛있닭" />
        </label>
      </div>

      <div className="fd-row">
        <NumField label="기준 수량" value={d.base_amount} onChange={(v) => set('base_amount', v)} />
        <label className="bn-field fd-narrow">
          <span className="muted small">단위</span>
          <input className="em-input" list="fd-units" value={d.base_unit} onChange={(e) => set('base_unit', e.target.value)} />
          <datalist id="fd-units">
            {COMMON_UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </label>
        <NumField label="그램 환산" value={d.base_grams} onChange={(v) => set('base_grams', v)} placeholder="모르면 비움" />
      </div>
      <p className="muted small fd-basis">
        아래 영양소는{' '}
        <b>
          {d.base_amount || '?'}
          {d.base_unit}
        </b>{' '}
        기준입니다{grams ? ` (= ${grams}g — g 단위로도 기록 가능)` : ''}.
      </p>

      <div className="fd-grid">
        {MAIN.map((n) => (
          <NumField
            key={n}
            label={`${NUTRIENT_LABEL[n]} (${NUTRIENT_UNIT[n]})`}
            value={d[n]}
            onChange={(v) => set(n, v)}
            placeholder="—"
          />
        ))}
      </div>

      <button className="link-btn small" onClick={() => setShowMore((v) => !v)}>
        {showMore ? '자세한 영양소 접기' : `자세한 영양소 ${MORE.length}개 펼치기`}
      </button>
      {showMore && (
        <div className="fd-grid">
          {MORE.map((n) => (
            <NumField
              key={n}
              label={`${NUTRIENT_LABEL[n]} (${NUTRIENT_UNIT[n]})`}
              value={d[n]}
              onChange={(v) => set(n, v)}
              placeholder="—"
            />
          ))}
        </div>
      )}

      {badFields.length > 0 && (
        <p className="error small">숫자가 아닌 값이 들어간 칸이 있습니다 — 빨간 칸을 고쳐 주세요.</p>
      )}

      <div className="fd-actions">
        <button className="sync-btn" disabled={busy || !canSave} onClick={() => void submit()}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button className="link-btn small" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  )
}

/**
 * 숫자 입력칸.
 *
 * 값을 **문자열 그대로** 주고받는다. 파싱은 저장할 때만 한다 — 그래야 "0." 처럼
 * 아직 덜 친 입력이 살아 있고, 잘못 친 글자도 지우고 다시 칠 수 있다.
 */
function NumField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const bad = isBadNum(value)
  return (
    <label className="bn-field fd-narrow">
      <span className="muted small">{label}</span>
      <input
        className={`em-input ${bad ? 'bad' : ''}`}
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={bad}
      />
    </label>
  )
}
