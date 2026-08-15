import { useCallback, useEffect, useMemo, useState } from 'react'
import dayjs from 'dayjs'
import { errMsg, fetchActivities, type Activity } from '../../lib/exercise'
import { fetchSessions, type StrengthSession } from '../../lib/strength'
import {
  fetchGoals,
  fetchMeasurements,
  fetchNutrition,
  fetchSettings,
  heightCm,
  latest,
  leanMassKg,
  type BodyGoal,
  type BodyMeasurement,
  type BodySettings,
  type NutritionLog,
} from '../../lib/body'
import { buildPlan } from '../../lib/coach'
import { BodyGoals } from './BodyGoals'
import { BodyCoach } from './BodyCoach'
import { BodyNutrition } from './BodyNutrition'
import { BodyChart } from './BodyChart'
import { BodyMeasurements } from './BodyMeasurements'

export function BodyTab({ syncNonce }: { syncNonce: number }) {
  const [measurements, setMeasurements] = useState<BodyMeasurement[]>([])
  const [goals, setGoals] = useState<BodyGoal[]>([])
  const [nutrition, setNutrition] = useState<NutritionLog[]>([])
  const [settings, setSettings] = useState<BodySettings>({
    height_cm: null,
    sex: null,
    birth_year: null,
    neat_factor: 1.25,
  })
  const [activities, setActivities] = useState<Activity[]>([])
  const [sessions, setSessions] = useState<StrengthSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      // 코칭에 쓰는 활동·근력은 최근 것만 있으면 된다 (하루 평균 소모는 4주 창으로 본다)
      const since = dayjs().subtract(60, 'day').format('YYYY-MM-DD')
      const [ms, gs, ns, st, acts, ss] = await Promise.all([
        fetchMeasurements(),
        fetchGoals(),
        fetchNutrition(since),
        fetchSettings(),
        fetchActivities(since),
        fetchSessions(since),
      ])
      setMeasurements(ms)
      setGoals(gs)
      setNutrition(ns)
      setSettings(st)
      setActivities(acts)
      setSessions(ss)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, syncNonce])

  const plan = useMemo(
    () => buildPlan({ measurements, goals, activities, sessions, nutrition, settings }),
    [measurements, goals, activities, sessions, nutrition, settings],
  )

  if (loading) return <p className="muted">체형 데이터 불러오는 중…</p>

  const m = latest(measurements)
  const lean = leanMassKg(m)
  const h = heightCm(measurements, settings)

  return (
    <>
      {error && <p className="error">{error}</p>}

      {measurements.length === 0 && (
        <div className="card notice-card">
          아직 인바디 기록이 없습니다. 아래 <b>측정 이력</b> 에서 InBody 앱이 내보낸 CSV 를 올리면 추이와 목표 계산이 시작됩니다.
        </div>
      )}

      {m && (
        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-val">
              {m.weight_kg ?? '-'}
              <span>kg</span>
            </div>
            <div className="kpi-label">
              체중 · {dayjs(m.measured_at).format('M/D')} 측정
              <Delta measurements={measurements} field="weight_kg" unit="kg" />
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-val">
              {m.body_fat_pct ?? '-'}
              <span>%</span>
            </div>
            <div className="kpi-label">
              체지방률
              <Delta measurements={measurements} field="body_fat_pct" unit="%" lowerIsBetter />
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-val">
              {m.skeletal_muscle_kg ?? '-'}
              <span>kg</span>
            </div>
            <div className="kpi-label">
              골격근량
              <Delta measurements={measurements} field="skeletal_muscle_kg" unit="kg" />
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-val">{lean ?? '-'}<span>kg</span></div>
            <div className="kpi-label">
              제지방량{h ? ` · ${h}cm` : ''}
              {m.inbody_score != null && ` · 점수 ${m.inbody_score}`}
            </div>
          </div>
        </div>
      )}

      <div className="ex-stack">
        <BodyGoals goals={goals} measurements={measurements} onChanged={() => void load()} />
        <BodyCoach plan={plan} />
        <div className="ex-grid">
          <BodyNutrition nutrition={nutrition} plan={plan} onChanged={() => void load()} />
          <BodyChart measurements={measurements} />
        </div>
        <BodyMeasurements
          measurements={measurements}
          settings={settings}
          derivedHeight={h}
          onChanged={() => void load()}
        />
      </div>
    </>
  )
}

/** 직전 측정 대비 변화. 좋아진 방향이면 초록, 나빠진 방향이면 빨강. */
function Delta({
  measurements,
  field,
  unit,
  lowerIsBetter,
}: {
  measurements: BodyMeasurement[]
  field: 'weight_kg' | 'body_fat_pct' | 'skeletal_muscle_kg'
  unit: string
  lowerIsBetter?: boolean
}) {
  const vals = measurements.filter((x) => x[field] != null)
  if (vals.length < 2) return null
  const cur = vals[vals.length - 1][field] as number
  const prev = vals[vals.length - 2][field] as number
  const d = Math.round((cur - prev) * 10) / 10
  if (d === 0) return <span className="muted"> · 직전과 같음</span>
  // 체중은 방향만으로 좋고 나쁨을 말할 수 없다 — 색을 입히지 않는다
  const cls = lowerIsBetter === undefined ? 'muted' : (lowerIsBetter ? d < 0 : d > 0) ? 'delta-up' : 'delta-down'
  return (
    <span className={cls}>
      {' '}
      · 직전 {d > 0 ? '+' : ''}
      {d}
      {unit}
    </span>
  )
}
