import { useEffect, useRef, useState } from 'react'
import { errMsg } from '../../lib/exercise'
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

// 음식 등록·편집. AI 가 읽은 결과도 **여기에 채워 놓고** 사람이 확인한 뒤 저장한다.
// 잘못 읽은 숫자가 그대로 합계에 들어가지 않게 하려는 것이다.

const POLL_MS = 2500

/** 표에 자주 있는 것만 위로. 나머지는 접어 둔다 — 입력 칸이 11개면 질린다. */
const MAIN: Nutrient[] = ['kcal', 'carb_g', 'protein_g', 'fat_g']
const MORE: Nutrient[] = NUTRIENTS.filter((n) => !MAIN.includes(n))

const EMPTY: FoodInput = {
  name: '',
  brand: null,
  base_amount: 100,
  base_unit: 'g',
  base_grams: null,
  source: 'manual',
  note: null,
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
  const [f, setF] = useState<FoodInput>(() => (initial ? { ...initial } : { ...EMPTY }))
  const [showMore, setShowMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── AI 로 채우기 ──
  const [aiOpen, setAiOpen] = useState(false)
  const [aiText, setAiText] = useState('')
  const [aiState, setAiState] = useState<'idle' | 'uploading' | 'waiting'>('idle')
  const [aiNote, setAiNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pending = useRef<{ threadId: string; messageId: string } | null>(null)

  const set = <K extends keyof FoodInput>(k: K, v: FoodInput[K]) => setF((p) => ({ ...p, [k]: v }))
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v))

  // 답이 올 때까지 훑는다. 집 PC 에이전트가 답하는 데 보통 수십 초.
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
        setF((prev) => ({ ...prev, ...parsed.food, source: prev.source === 'manual' ? 'ai-photo' : prev.source }))
        setAiOpen(false)
        setAiNote('AI 가 채웠습니다. 숫자를 확인하고 저장하세요.')
      })
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [aiState])

  async function runPhoto(file: File) {
    setError(null)
    setAiState('uploading')
    try {
      const { signedUrl } = await uploadLabelPhoto(file)
      const p = photoPrompt(signedUrl)
      pending.current = await askFoodParse(p)
      set('source', 'ai-photo')
      setAiState('waiting')
    } catch (e) {
      setAiState('idle')
      setError(errMsg(e))
    }
  }

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
    if (!f.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await saveFood({ ...f, name: f.name.trim() }, initial?.id))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const waiting = aiState !== 'idle'

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
            📷 영양정보표 사진
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
            사진은 <b>음식 사진이 아니라 영양정보표</b>를 찍은 것이어야 합니다. 집 PC 의 OpenClaw 가 읽습니다.
          </p>
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      <div className="fd-row">
        <label className="bn-field fd-grow">
          <span className="muted small">음식 이름</span>
          <input className="em-input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="닭가슴살 스테이크" />
        </label>
        <label className="bn-field">
          <span className="muted small">브랜드</span>
          <input className="em-input" value={f.brand ?? ''} onChange={(e) => set('brand', e.target.value || null)} placeholder="맛있닭" />
        </label>
      </div>

      <div className="fd-row">
        <label className="bn-field fd-narrow">
          <span className="muted small">기준 수량</span>
          <input
            className="em-input"
            inputMode="decimal"
            value={String(f.base_amount)}
            onChange={(e) => set('base_amount', Number(e.target.value) || 0)}
          />
        </label>
        <label className="bn-field fd-narrow">
          <span className="muted small">단위</span>
          <input
            className="em-input"
            list="fd-units"
            value={f.base_unit}
            onChange={(e) => set('base_unit', e.target.value)}
          />
          <datalist id="fd-units">
            {COMMON_UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </label>
        <label className="bn-field fd-narrow">
          <span className="muted small">그램 환산</span>
          <input
            className="em-input"
            inputMode="decimal"
            placeholder="모르면 비움"
            value={f.base_grams == null ? '' : String(f.base_grams)}
            onChange={(e) => set('base_grams', num(e.target.value))}
          />
        </label>
      </div>
      <p className="muted small fd-basis">
        아래 영양소는 <b>
          {f.base_amount}
          {f.base_unit}
        </b>{' '}
        기준입니다{f.base_grams ? ` (= ${f.base_grams}g — g 단위로도 기록 가능)` : ''}.
      </p>

      <div className="fd-grid">
        {MAIN.map((n) => (
          <NutrientField key={n} n={n} value={f[n]} onChange={(v) => set(n, v)} />
        ))}
      </div>

      <button className="link-btn small" onClick={() => setShowMore((v) => !v)}>
        {showMore ? '자세한 영양소 접기' : `자세한 영양소 ${MORE.length}개 펼치기`}
      </button>
      {showMore && (
        <div className="fd-grid">
          {MORE.map((n) => (
            <NutrientField key={n} n={n} value={f[n]} onChange={(v) => set(n, v)} />
          ))}
        </div>
      )}

      <div className="fd-actions">
        <button className="sync-btn" disabled={busy || !f.name.trim()} onClick={() => void submit()}>
          {busy ? '저장 중…' : '저장'}
        </button>
        <button className="link-btn small" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  )
}

function NutrientField({
  n,
  value,
  onChange,
}: {
  n: Nutrient
  value: number | null | undefined
  onChange: (v: number | null) => void
}) {
  return (
    <label className="bn-field">
      <span className="muted small">
        {NUTRIENT_LABEL[n]} ({NUTRIENT_UNIT[n]})
      </span>
      <input
        className="em-input"
        inputMode="decimal"
        placeholder="—"
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value.trim() === '' ? null : Number(e.target.value))}
      />
    </label>
  )
}
