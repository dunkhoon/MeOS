import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { runIntervalsSync } from '../lib/sync'
import { ActivityTab } from '../components/exercise/ActivityTab'
import { StrengthTab } from '../components/exercise/StrengthTab'
import { BodyTab } from '../components/exercise/BodyTab'

// 서브탭은 URL 에 둔다 — 뒤로가기가 먹고, 링크로 바로 열 수 있고, 새로고침해도 그 자리다.
// (상태로만 들면 새로고침 때마다 '활동'으로 튕긴다)
const TABS = [
  { key: 'activity', label: '활동', desc: 'intervals.icu · 훈련부하 · 활동 · 컨디션' },
  { key: 'strength', label: '근력', desc: '세트 기록 · 근력 캘린더 · 종목별 볼륨' },
  { key: 'body', label: '체형·목표', desc: '인바디 · 목표 진행률 · 영양 · 조정 조언' },
] as const

type TabKey = (typeof TABS)[number]['key']

function isTabKey(v: string | undefined): v is TabKey {
  return TABS.some((t) => t.key === v)
}

export default function Exercise() {
  const { tab } = useParams<{ tab?: string }>()
  const navigate = useNavigate()
  const active: TabKey = isTabKey(tab) ? tab : 'activity'

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  // 동기화가 끝나면 이 값을 올려 탭에게 "다시 읽어라" 고 알린다
  const [syncNonce, setSyncNonce] = useState(0)

  // 평소엔 최근 60일치만 당긴다 (자주 눌러도 가볍게). full 은 과거 전체를 다시 채울 때.
  async function handleSync(full = false) {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const r = await runIntervalsSync({ full })
      setSyncNonce((n) => n + 1)
      setSyncMsg(
        `동기화 완료${full ? ' (전체 기간)' : ''} · 활동 ${r.activities} · 웰니스 ${r.wellness} · 대회 ${r.races}` +
          (r.events ? ` · 일정 ${r.events}` : '') +
          (r.shoes ? ` · 러닝화 ${r.shoes}` : '') +
          // 러닝화만 실패해도 나머지는 반영됐다 — 조용히 넘기지 않고 알린다
          (r.shoesError ? ` (러닝화: ${r.shoesError})` : ''),
      )
    } catch (e) {
      setSyncMsg('동기화 실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(false)
    }
  }

  const meta = TABS.find((t) => t.key === active)!
  // 근력은 intervals.icu 와 무관한 자체 기록이라 동기화 버튼이 할 일이 없다
  const showSync = active !== 'strength'

  return (
    <div className="page">
      <header className="page-head ex-head">
        <div>
          <h2>운동</h2>
          <p className="muted">{meta.desc}</p>
        </div>
        {showSync && (
          <div className="sync-actions">
            <button className="sync-btn" onClick={() => void handleSync(false)} disabled={syncing}>
              {syncing ? (
                <>
                  <span className="spinner" />
                  동기화 중…
                </>
              ) : (
                <>↻ 새로고침</>
              )}
            </button>
            {/* 최근분만 받는 게 기본이라, 과거를 처음 채울 때 쓸 길을 열어 둔다 */}
            <button
              className="link-btn small"
              onClick={() => void handleSync(true)}
              disabled={syncing}
              title="과거 활동·웰니스를 전부 다시 가져옵니다 (오래 걸릴 수 있음)"
            >
              전체 기간
            </button>
          </div>
        )}
      </header>

      <nav className="ex-tabs" role="tablist" aria-label="운동 화면">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === active}
            className={`ex-tab ${t.key === active ? 'active' : ''}`}
            // '활동' 은 /exercise 를 정식 주소로 둔다 (사이드바·QuickSearch 가 가리키는 곳)
            onClick={() => navigate(t.key === 'activity' ? '/exercise' : `/exercise/${t.key}`)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {syncMsg && <div className={`sync-msg ${syncMsg.startsWith('동기화 실패') ? 'err' : ''}`}>{syncMsg}</div>}

      {active === 'activity' && <ActivityTab syncNonce={syncNonce} />}
      {active === 'strength' && <StrengthTab />}
      {active === 'body' && <BodyTab syncNonce={syncNonce} />}
    </div>
  )
}
