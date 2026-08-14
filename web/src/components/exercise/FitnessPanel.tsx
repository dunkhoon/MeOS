import { useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fitnessSeries, type Wellness } from '../../lib/exercise'
import { CollapsibleCard } from '../CollapsibleCard'
import { ink } from '../../lib/color'

type MetricKey = 'fitness' | 'fatigue' | 'form'

interface Metric {
  key: MetricKey
  label: string
  color: string
  /** 범례에 마우스를 올렸을 때 보여줄 설명 */
  help: string
}

// intervals.icu 의 훈련부하 지표. form 은 이 앱에서 ctl − atl 로 계산한다 (SPEC §7).
const METRICS: Metric[] = [
  {
    key: 'fitness',
    label: 'Fitness(CTL)',
    color: 'var(--info)',
    help: '최근 42일간 훈련량의 지수가중 평균 — 쌓아 올린 “체력”. 천천히 오르고 천천히 떨어져서, 꾸준히 훈련할수록 높아집니다.',
  },
  {
    key: 'fatigue',
    label: 'Fatigue(ATL)',
    // 액센트는 테마마다 파랑일 수 있어 CTL 과 겹친다 — 색상환에서 직접 고른다
    color: 'var(--h-orange)',
    help: '최근 7일간 훈련량의 지수가중 평균 — 지금 쌓인 “피로”. 며칠만 몰아서 타도 금방 치솟고, 쉬면 빠르게 떨어집니다.',
  },
  {
    key: 'form',
    label: 'Form(TSB)',
    color: 'var(--ok)',
    help: 'Fitness − Fatigue. 지금 몸이 얼마나 가벼운지를 나타냅니다. 대략 +5 이상이면 회복돼 레이스에 좋은 상태, −10~+5는 평소 훈련 구간, −30 아래에 오래 머무르면 과훈련을 의심해 보세요.',
  },
]

export function FitnessPanel({ wellness }: { wellness: Wellness[] }) {
  const data = fitnessSeries(wellness)

  // 러닝화는 이제 실제 데이터(Garmin)라 목록이 길어서 별도 전체폭 카드로 뺐다 (SPEC §3.1 변경).
  return (
    <CollapsibleCard id="ex-fitness" title="Fitness (훈련부하)">
      {data.length === 0 ? (
        <p className="muted small">데이터 없음</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} />
              {METRICS.map((m) => (
                <Line
                  key={m.key}
                  type="monotone"
                  dataKey={m.key}
                  name={m.label}
                  stroke={m.color}
                  dot={false}
                  strokeWidth={m.key === 'form' ? 1.5 : 2}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <MetricLegend />
        </>
      )}
    </CollapsibleCard>
  )
}

/**
 * 차트 아래 범례. Recharts 기본 <Legend> 대신 직접 그려서, 각 항목에 마우스를 올리면
 * 그 수치가 무슨 뜻인지 설명을 띄운다. (터치 기기에서는 탭으로 토글)
 */
/** 툴팁 최대 폭과 화면 가장자리 여백 — CSS 의 .metric-tip 과 같은 값을 써야 한다 */
const TIP_MAX = 300
const TIP_EDGE = 12

function MetricLegend() {
  const [tip, setTip] = useState<{ metric: Metric; x: number; y: number; below: boolean } | null>(null)

  const show = (metric: Metric, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    // 위쪽 공간이 모자라면 아래로 내려서 잘리지 않게
    const below = r.top < 170
    // 툴팁은 항목 가운데에 붙지만(translateX(-50%)) 화면 끝 항목에서는 그대로 밖으로 나간다.
    // 최대 폭 기준으로 좌우 여백을 확보하도록 중심을 화면 안쪽으로 당긴다.
    const half = Math.min(TIP_MAX, window.innerWidth - TIP_EDGE * 2) / 2
    const center = r.left + r.width / 2
    const x = Math.min(Math.max(center, TIP_EDGE + half), window.innerWidth - TIP_EDGE - half)
    setTip({ metric, x, y: below ? r.bottom : r.top, below })
  }

  return (
    <div className="fit-legend">
      {METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          className="fit-lg-item"
          aria-label={`${m.label} — ${m.help}`}
          onMouseEnter={(e) => show(m, e.currentTarget)}
          onMouseLeave={() => setTip(null)}
          onFocus={(e) => show(m, e.currentTarget)}
          onBlur={() => setTip(null)}
          onClick={(e) => (tip?.metric.key === m.key ? setTip(null) : show(m, e.currentTarget))}
        >
          <span className="fit-lg-dot" style={{ background: m.color }} />
          {m.label}
        </button>
      ))}

      {tip && (
        <div className={`metric-tip ${tip.below ? 'below' : ''}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
          <b style={{ color: ink(tip.metric.color) }}>{tip.metric.label}</b>
          <p>{tip.metric.help}</p>
        </div>
      )}
    </div>
  )
}
