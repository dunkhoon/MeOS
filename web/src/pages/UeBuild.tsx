import { useCallback, useEffect, useRef, useState } from 'react'
import { CollapsibleCard } from '../components/CollapsibleCard'
import {
  baseName,
  basisLabel,
  fmtClock,
  fmtElapsed,
  fmtSeconds,
  headline,
  originIcon,
  pct,
  phaseLabel,
  targetLabel,
} from '../lib/uebuild'

// UE 빌드 — PC 전용.
//
// 이 화면이 답해야 하는 질문은 셋이다.
//   1) 지금 빌드가 도는가?          → 프로세스(UBT)가 있는가로 답한다
//   2) 어디까지 갔는가?             → UBT 로그로 답한다
//   3) **누가 걸었는가?**            → 부모 프로세스 사슬로 답한다 (main 이 판정해 온다)
//
// 세 답의 근거가 서로 다르다는 걸 화면에서도 숨기지 않는다. 로그는 프로세스보다 늦고,
// 빌드가 끝난 뒤에도 남아 있다 — 그래서 "도는가" 는 로그로 판정하지 않고, 로그가 낡았으면
// 낡았다고 적는다. 진행률도 근거(완료/착수)를 같이 적는다.
//
// 읽기 전용이다. 빌드를 걸거나 죽이는 버튼은 두지 않는다.

const AUTO_KEY = 'pp:ue:auto'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function UeBuild() {
  const bridge = window.desktop?.uebuild

  const [cfg, setCfg] = useState<UeConfig | null>(null)
  const [status, setStatus] = useState<UeStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [auto, setAuto] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [pollSec, setPollSec] = useState(6)

  /** 조회 한 번이 2초쯤 걸린다 — 겹쳐 부르면 PowerShell 만 쌓인다. */
  const inFlight = useRef(false)
  /** 빌드가 사라진 순간을 잡아 "방금 끝났다" 를 보여 주려고 직전 목록을 들고 있는다. */
  const prevBuilds = useRef<UeBuild[]>([])
  const [justFinished, setJustFinished] = useState<{ at: string; builds: UeBuild[] } | null>(null)

  const refresh = useCallback(async () => {
    if (!bridge || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const s = await bridge.status()
      setStatus(s)
      setErr(s.ok ? null : (s.error ?? '상태를 읽지 못했습니다.'))
      if (prevBuilds.current.length && !s.builds.length) {
        setJustFinished({ at: s.at, builds: prevBuilds.current })
      } else if (s.builds.length) {
        setJustFinished(null)
      }
      prevBuilds.current = s.builds
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [bridge])

  useEffect(() => {
    if (!bridge) return
    void (async () => {
      try {
        const c = await bridge.getConfig()
        setCfg(c)
        setPollSec(c.pollSec)
      } catch (e) {
        setErr(errMsg(e))
      }
      void refresh()
    })()
  }, [bridge, refresh])

  // 자동 새로고침. 탭이 안 보이는 동안은 쉬게 둔다 — 조회가 싸지 않다.
  useEffect(() => {
    if (!bridge || !auto) return
    const tick = () => {
      if (document.hidden) return
      void refresh()
    }
    const id = window.setInterval(tick, Math.max(3, pollSec) * 1000)
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [bridge, auto, pollSec, refresh])

  const toggleAuto = () => {
    setAuto((a) => {
      const next = !a
      try {
        localStorage.setItem(AUTO_KEY, next ? '1' : '0')
      } catch {
        /* localStorage 불가 시 이 세션에만 적용 */
      }
      return next
    })
  }

  const savePoll = async (sec: number) => {
    setPollSec(sec)
    await bridge?.setConfig({ pollSec: sec })
  }

  const chooseEngine = async (root: string) => {
    if (!bridge) return
    const r = await bridge.setConfig({ engineRoot: root })
    if (!r.ok) {
      setErr(r.error ?? '엔진 경로를 저장하지 못했습니다.')
      return
    }
    setCfg((c) => (c ? { ...c, engineRoot: root, engineRootSaved: root } : c))
    setNotice(`엔진 경로를 ${root} 로 두었습니다.`)
    void refresh()
  }

  const pickEngine = async () => {
    const r = await bridge?.pickEngine()
    if (r?.ok && r.dir) void chooseEngine(r.dir)
  }

  // 구 버전 exe 에는 이 브리지가 없다. 데스크톱이지만 기능이 통째로 빠진 상태다.
  if (!bridge) {
    return (
      <div className="page">
        <header className="page-head">
          <h2>UE 빌드</h2>
        </header>
        <div className="card">
          <p>이 데스크톱 앱에는 UE 빌드 감시 기능이 아직 들어 있지 않습니다.</p>
          <p className="muted small">앱을 다시 빌드해서 설치하면 나타납니다.</p>
        </div>
      </div>
    )
  }

  const head = headline(status)
  const log = status?.log ?? null
  const logFresh = !!log?.ok && !!log.fresh
  const running = !!status?.running

  return (
    <div className="page">
      <header className="page-head">
        <h2>UE 빌드</h2>
        <p className="muted">지금 빌드가 도는지 · 어디까지 갔는지 · 누가 걸었는지</p>
      </header>

      {err && <div className="error">{err}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* ── 상태 ── */}
      <div className={`card ub-hero ub-${head.state}`}>
        <div className="ub-hero-main">
          <span className="ub-dot" aria-hidden />
          <div className="ub-hero-text">
            <div className="ub-hero-title">{head.text}</div>
            <div className="muted small">
              {running
                ? status!.builds
                    .flatMap((b) => b.targets.map(targetLabel))
                    .slice(0, 3)
                    .join(' / ') || '대상 확인 중'
                : logFresh && log?.totalSeconds != null
                  ? `마지막 빌드 ${fmtSeconds(log.totalSeconds)} · ${phaseLabel(log.phase)}`
                  : '이 PC 에서 도는 UE 빌드가 없습니다'}
            </div>
          </div>
        </div>

        <div className="ub-hero-side">
          <button type="button" className="btn-secondary small-btn" onClick={() => void refresh()} disabled={busy}>
            {busy ? '확인 중…' : '지금 확인'}
          </button>
          <button type="button" className={`chip chip-btn ub-auto${auto ? ' on' : ''}`} onClick={toggleAuto}>
            자동 {auto ? '켬' : '끔'}
          </button>
          <div className="seg ub-poll">
            {[3, 6, 15, 30].map((s) => (
              <button
                key={s}
                type="button"
                className={`seg-btn${pollSec === s ? ' active' : ''}`}
                onClick={() => void savePoll(s)}
                disabled={!auto}
              >
                {s}초
              </button>
            ))}
          </div>
          <div className="muted small">{status ? `${fmtClock(status.at)} 확인` : ''}</div>
        </div>
      </div>

      {/* ── 누가 걸었나 ── */}
      {running &&
        status!.builds.map((b) => <BuildCard key={b.pid} build={b} />)}

      {!running && justFinished && (
        <div className="card ub-finished">
          <div className="ub-finished-head">방금 끝났습니다 · {fmtClock(justFinished.at)}</div>
          {justFinished.builds.map((b) => (
            <div key={b.pid} className="ub-finished-row">
              <OriginBadge origin={b.origin} compact />
              <span className="ub-finished-target">{b.targets.map(targetLabel).join(' / ')}</span>
              <span className="muted small">
                {log?.totalSeconds != null ? `총 ${fmtSeconds(log.totalSeconds)}` : fmtElapsed(b.elapsedMs)}
                {log?.phase === 'error' ? ' · 오류로 끝남' : ''}
              </span>
            </div>
          ))}
          <p className="muted small">
            주체는 빌드가 돌던 동안 확인한 값입니다. 프로세스가 사라진 뒤에는 누가 걸었는지 다시 알아낼 방법이 없어,
            마지막으로 본 값을 그대로 둡니다.
          </p>
        </div>
      )}

      {!running && !justFinished && log?.ok && log.targets && log.targets.length > 0 && (
        <div className="card ub-last">
          <div className="card-title">마지막 빌드 (로그에 남은 것)</div>
          <div className="ub-last-row">
            <span className="ub-last-target">{log.targets.map(targetLabel).join(' / ')}</span>
            <span className={`chip ub-phase ub-phase-${log.phase}`}>{phaseLabel(log.phase)}</span>
            {log.totalSeconds != null && <span className="muted small">총 {fmtSeconds(log.totalSeconds)}</span>}
          </div>
          <p className="muted small">
            {fmtClock(log.mtime)} 에 마지막으로 쓰인 로그입니다. 로그에는 <b>무엇을</b> 빌드했는지만 남고
            <b> 누가</b> 걸었는지는 남지 않습니다 — 그건 프로세스가 살아 있는 동안에만 알 수 있습니다.
          </p>
        </div>
      )}

      {/* ── 어디까지 갔나 ── */}
      {log?.ok && (running || logFresh) && (
        <div className="card ub-progress">
          <div className="card-title">
            진행 상황
            {log.executor && <span className="chip ub-exec">{log.executor}</span>}
            {!logFresh && <span className="chip bad">로그가 {fmtElapsed(log.ageMs)} 동안 안 움직임</span>}
          </div>

          <div className="ub-phase-row">
            <span className={`chip ub-phase ub-phase-${log.phase}`}>{phaseLabel(log.phase)}</span>
            {log.building && <span className="muted small">{log.building}</span>}
          </div>

          {log.progress ? (
            <div className="ub-bar-wrap">
              <div className="ub-bar">
                <div className="ub-bar-fill" style={{ width: `${pct(log.progress)}%` }} />
              </div>
              <div className="ub-bar-label">
                <b>{pct(log.progress)}%</b>
                <span className="muted small">
                  {log.progress.done} / {log.progress.total} 액션 · {basisLabel(log.progress.basis)}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted small">아직 액션 수를 알 수 없습니다 (준비 단계이거나, 실행기가 개수를 안 찍었습니다).</p>
          )}

          {!!log.actions?.length && (
            <ul className="ub-actions">
              {log.actions.slice().reverse().map((a, i) => (
                <li key={`${a}-${i}`}>{a}</li>
              ))}
            </ul>
          )}

          {!!log.agents?.length && (
            <div className="ub-agents">
              <span className="muted small">분산 노드</span>
              {log.agents.map((a) => (
                <span key={a.ip} className={`chip ub-agent${a.ok === false ? ' bad' : a.ok ? ' ok' : ''}`}>
                  {a.ip}
                  {a.ok === false ? ' 실패' : ''}
                </span>
              ))}
            </div>
          )}

          {!!log.errors?.length && (
            <div className="ub-errors">
              <div className="ub-errors-head">오류 {log.errors.length}건</div>
              {log.errors.map((e, i) => (
                <div key={i} className="ub-error-line">
                  {e}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 일꾼 · 걸림돌 ── */}
      {(running || logFresh) && (!!status?.workers.length || !!status?.editors.length) && (
        <div className="card ub-workers-card">
          {!!status.workers.length && (
            <>
              <div className="card-title">지금 도는 일꾼</div>
              <div className="ub-workers">
                {status.workers.map((w) => (
                  <div key={w.label} className="ub-worker">
                    <span className="ub-worker-n">{w.count}</span>
                    <span className="ub-worker-label">{w.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {!!status.editors.length && (
            <p className="ub-warn">
              UnrealEditor {status.editors.length}개가 떠 있습니다 (pid {status.editors.map((e) => e.pid).join(', ')}).
              에디터가 dll 을 잡고 있으면 링크 단계에서 빌드가 깨집니다.
            </p>
          )}

          {running && status.builds.some((b) => b.origin.kind !== 'vs') && (
            <p className="ub-warn">
              {status.builds.some((b) => b.liveCoding)
                ? '에디터의 라이브 코딩이 UBT 를 잡고 있습니다. '
                : '다른 곳에서 건 빌드가 UBT 를 잡고 있습니다. '}
              Visual Studio 에서 같은 타겟을 빌드하면 전역 뮤텍스에 막혀 아무 반응 없이 기다립니다 — 이 빌드가 끝난
              뒤에 돌리세요.
            </p>
          )}
        </div>
      )}

      {/* ── 로그 원문 ── */}
      {log?.ok && !!log.tail?.length && (
        <CollapsibleCard
          id="ue-log"
          title={`UBT 로그 (마지막 ${log.tail.length}줄)`}
          actions={
            <>
              <button type="button" className="link-btn" onClick={() => void bridge.openLog()}>
                열기
              </button>
              <button type="button" className="link-btn" onClick={() => void bridge.revealLog()}>
                폴더
              </button>
            </>
          }
        >
          <pre className="ub-log">{log.tail.join('\n')}</pre>
          <p className="muted small">{log.path}</p>
        </CollapsibleCard>
      )}

      {/* ── 엔진 ── */}
      <CollapsibleCard id="ue-engine" title="엔진 경로">
        <p className="muted small">
          UBT 로그를 어디서 읽을지 정합니다. 빌드가 도는 동안에는 프로세스에서 저절로 알아내 기억해 두므로,
          보통은 손댈 일이 없습니다.
        </p>

        <div className="ub-engine-cur">
          <span className="ub-engine-path">{cfg?.engineRoot || status?.engineRoot || '(정해지지 않음)'}</span>
          {status?.engineRootDetected && (
            <span className="chip">도는 빌드에서 확인: {status.engineRootDetected}</span>
          )}
        </div>

        {!!cfg?.engines.length && (
          <div className="ub-engines">
            {cfg.engines.map((e) => (
              <button
                key={e.root}
                type="button"
                className={`ub-engine${(cfg.engineRoot || '').toLowerCase() === e.root.toLowerCase() ? ' on' : ''}`}
                onClick={() => void chooseEngine(e.root)}
              >
                <span className="ub-engine-name">{e.name}</span>
                <span className="ub-engine-root">{e.root}</span>
                <span className="muted small">
                  {e.source === 'source' ? '소스 빌드' : '런처 설치'}
                  {e.logMtime ? ` · 마지막 빌드 ${fmtClock(e.logMtime)}` : ' · 빌드 기록 없음'}
                </span>
              </button>
            ))}
          </div>
        )}

        <button type="button" className="btn-secondary small-btn" onClick={() => void pickEngine()}>
          직접 고르기…
        </button>
      </CollapsibleCard>
    </div>
  )
}

// ── 빌드 한 건 ──────────────────────────────────────────────

function BuildCard({ build }: { build: UeBuild }) {
  const o = build.origin
  return (
    <div className="card ub-build">
      <div className="ub-build-head">
        <OriginBadge origin={o} />
        <div className="ub-build-time">
          <div className="ub-elapsed">{fmtElapsed(build.elapsedMs)}</div>
          <div className="muted small">{fmtClock(build.startedAt)} 시작 · UBT pid {build.pid}</div>
        </div>
      </div>

      <div className="ub-targets">
        {build.targets.length ? (
          build.targets.map((t, i) => (
            <div key={`${t.target}-${i}`} className="ub-target">
              <b>{t.target ?? '(대상 불명)'}</b>
              <span className="ub-target-cfg">
                {[t.platform, t.configuration].filter(Boolean).join(' · ') || '—'}
              </span>
              {t.project && <span className="muted small">{baseName(t.project)}</span>}
            </div>
          ))
        ) : (
          <div className="muted small">빌드 대상을 읽지 못했습니다.</div>
        )}
        {build.liveCoding && <span className="chip ub-live">라이브 코딩</span>}
        {build.hotReload && <span className="chip">핫 리로드</span>}
      </div>

      <details className="ub-chain">
        <summary>어떻게 그렇게 판단했나</summary>
        <div className="ub-chain-body">
          <div className="ub-chain-list">
            {o.chain.map((n, i) => (
              <span key={n.pid}>
                {i > 0 && <span className="ub-chain-arrow">←</span>}
                <span className={`ub-chain-node${o.pid === n.pid ? ' hit' : ''}`}>
                  {n.name} <span className="muted">{n.pid}</span>
                </span>
              </span>
            ))}
          </div>
          <p className="muted small">
            자식에서 부모로 거슬러 올라간 프로세스 사슬입니다. 이 중 빌드를 건 주체로 볼 수 있는 것을 골랐습니다
            {o.confidence === 'guess' && ' — 부모가 이미 끝나 사슬이 끊겼고, 커맨드라인의 흔적으로 추측했습니다'}.
            {build.fromMsBuild && ' UBT 인자에 -FromMsBuild 가 있어 MSBuild(Visual Studio) 경유로 실행됐습니다.'}
          </p>
          <pre className="ub-cmd">{build.commandLine}</pre>
        </div>
      </details>
    </div>
  )
}

function OriginBadge({ origin, compact }: { origin: UeOrigin; compact?: boolean }) {
  return (
    <div className={`ub-origin ub-origin-${origin.kind}${compact ? ' compact' : ''}`}>
      <span className="ub-origin-icon" aria-hidden>
        {originIcon(origin.kind)}
      </span>
      <div className="ub-origin-text">
        <div className="ub-origin-label">
          {origin.label}
          {origin.confidence === 'guess' && <span className="chip ub-guess">추정</span>}
        </div>
        {origin.detail && <div className="muted small">{origin.detail}</div>}
        {!compact && origin.pid != null && <div className="muted small">pid {origin.pid}</div>}
      </div>
    </div>
  )
}
