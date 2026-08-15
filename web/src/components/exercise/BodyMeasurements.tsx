import { useRef, useState } from 'react'
import dayjs from 'dayjs'
import { CollapsibleCard } from '../CollapsibleCard'
import { errMsg } from '../../lib/exercise'
import { parseInBodyCsv } from '../../lib/inbody'
import { deleteMeasurement, saveSettings, upsertMeasurements, type BodyMeasurement, type BodySettings } from '../../lib/body'

// InBody 앱 CSV 업로드 + 측정 이력.
//
// 같은 파일을 두 번 올려도 늘지 않는다 — 측정 시각이 곧 그 측정의 신원이라 upsert 로 덮는다.

export function BodyMeasurements({
  measurements,
  settings,
  derivedHeight,
  onChanged,
}: {
  measurements: BodyMeasurement[]
  settings: BodySettings
  derivedHeight: number | null
  onChanged: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      let total = 0
      let skipped = 0
      const unmapped = new Set<string>()
      for (const f of Array.from(files)) {
        // 인바디 CSV 는 UTF-8(BOM) 이다. 파서가 BOM 을 벗긴다.
        const text = await f.text()
        const r = parseInBodyCsv(text)
        r.unmapped.forEach((u) => unmapped.add(u))
        skipped += r.skipped
        if (r.rows.length) total += await upsertMeasurements(r.rows)
      }
      setMsg(
        total === 0
          ? '읽을 수 있는 측정이 없었습니다. InBody 앱에서 내보낸 CSV 가 맞는지 확인해 주세요.'
          : `측정 ${total}건 반영${skipped ? ` · 날짜가 없어 건너뜀 ${skipped}건` : ''}` +
              (unmapped.size ? ` · 저장만 하고 화면엔 안 쓰는 열 ${unmapped.size}개` : ''),
      )
      onChanged()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const recent = [...measurements].reverse().slice(0, 12)

  return (
    <CollapsibleCard
      id="ex-body-meas"
      title="측정 이력"
      actions={<span className="muted small">{measurements.length}건</span>}
    >
      <div
        className={`bm-drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void handleFiles(e.dataTransfer.files)
        }}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
        {busy ? '읽는 중…' : 'InBody CSV 를 여기에 끌어다 놓거나 눌러서 고르세요'}
      </div>
      {msg && <p className="muted small">{msg}</p>}
      {error && <p className="error small">{error}</p>}

      <HeightRow settings={settings} derived={derivedHeight} onChanged={onChanged} />

      {recent.length > 0 && (
        <div className="bm-table-wrap">
          <table className="act-table bm-table">
            <thead>
              <tr>
                <th>측정일</th>
                <th>체중</th>
                <th>골격근</th>
                <th>체지방</th>
                <th>체지방률</th>
                <th>BMR</th>
                <th aria-label="삭제"></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((m) => (
                <tr key={m.id}>
                  <td>{dayjs(m.measured_at).format('YY.MM.DD HH:mm')}</td>
                  <td>{m.weight_kg ?? '-'}</td>
                  <td>{m.skeletal_muscle_kg ?? '-'}</td>
                  <td>{m.body_fat_kg ?? '-'}</td>
                  <td>{m.body_fat_pct != null ? `${m.body_fat_pct}%` : '-'}</td>
                  <td>{m.bmr_kcal ?? '-'}</td>
                  <td>
                    <button
                      className="link-btn small"
                      onClick={() => {
                        if (window.confirm('이 측정을 지웁니다.')) void deleteMeasurement(m.id).then(onChanged)
                      }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleCard>
  )
}

/** 신장·생활 계수. 신장은 인바디의 체중·BMI 로 역산되므로 보통 손댈 일이 없다. */
function HeightRow({
  settings,
  derived,
  onChanged,
}: {
  settings: BodySettings
  derived: number | null
  onChanged: () => void
}) {
  const [h, setH] = useState(settings.height_cm != null ? String(settings.height_cm) : '')
  const [neat, setNeat] = useState(String(settings.neat_factor))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await saveSettings({
        height_cm: h.trim() === '' ? null : Number(h),
        neat_factor: Number(neat) || 1.25,
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bm-settings">
      <label className="bn-field">
        <span className="muted small">신장 cm</span>
        <input
          className="em-input"
          inputMode="decimal"
          value={h}
          placeholder={derived != null ? `${derived} (BMI 역산)` : ''}
          onChange={(e) => setH(e.target.value)}
        />
      </label>
      <label className="bn-field">
        <span className="muted small">생활 활동 계수</span>
        <select className="st-select" value={neat} onChange={(e) => setNeat(e.target.value)}>
          <option value="1.15">1.15 · 거의 앉아서</option>
          <option value="1.25">1.25 · 사무직 (기본)</option>
          <option value="1.35">1.35 · 자주 서고 걷는 편</option>
          <option value="1.45">1.45 · 몸 쓰는 일</option>
        </select>
      </label>
      <button className="ghost-btn" disabled={busy} onClick={() => void save()}>
        {busy ? '저장 중…' : '저장'}
      </button>
      <span className="muted small bm-settings-note">운동 소모는 여기 안 들어갑니다 — 활동 기록에서 따로 더합니다.</span>
    </div>
  )
}
