import { useEffect, useState, type KeyboardEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { THEMES, getTheme, setTheme, type ThemeId } from '../lib/theme'
import { isDesktop } from '../lib/desktop'

export default function Settings() {
  const desktop = isDesktop()
  return (
    <div className="page">
      <header className="page-head">
        <h2>설정</h2>
        <p className="muted">{desktop ? '테마 · 계정 · Quick Search · 스니펫 · BTS 연결' : '테마 · 계정'}</p>
      </header>

      <ThemeSetting />

      {/* 계정은 모바일에서도 보여야 한다 — 비밀번호를 여기서 정한다 */}
      <AccountSetting />

      {/* PC 전용 설정은 브라우저에서 안내조차 띄우지 않는다 — 쓸 수 없는 걸 알려 봐야 자리만 찬다 */}
      {desktop && (
        <>
          <AppUrlSetting />
          <P4Setting />
          <ReviewSetting />
          <BtsSetting />
          <HotkeySetting />
          <SnippetManager />
        </>
      )}
    </div>
  )
}

// ── 테마 ────────────────────────────────────────────────────
// 미리보기 조각은 `[data-swatch]` 로 그 테마의 팔레트를 그대로 뒤집어쓴다.
// 색을 여기에 다시 적지 않으므로 index.css 만 고치면 미리보기까지 따라온다.

function ThemeSetting() {
  const [cur, setCur] = useState<ThemeId>(() => getTheme())

  const pick = (id: ThemeId) => {
    setTheme(id)
    setCur(id)
  }

  const groups = [
    { mode: 'dark' as const, label: '어두운 테마' },
    { mode: 'light' as const, label: '밝은 테마' },
  ]

  return (
    <div className="card setting-card">
      <h3 className="card-title">테마</h3>
      <p className="muted small">
        이 기기에만 적용됩니다. 에디터에서 널리 쓰이는 테마의 공식 팔레트를 그대로 옮겼습니다.
      </p>

      {groups.map((g) => (
        <div key={g.mode}>
          <div className="theme-group">{g.label}</div>
          <div className="theme-grid">
            {THEMES.filter((t) => t.mode === g.mode).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-card ${cur === t.id ? 'active' : ''}`}
                onClick={() => pick(t.id)}
                aria-pressed={cur === t.id}
              >
                {/* 이 조각 안에서는 --bg 등이 해당 테마 값으로 바뀐다 */}
                <span className="theme-prev" data-swatch={t.id}>
                  <span className="tp-bar">
                    <i className="tp-dot" />
                    <i className="tp-line" />
                  </span>
                  <span className="tp-body">
                    <i className="tp-card">
                      <b>12.4</b>
                      <s />
                    </i>
                    <i className="tp-hues">
                      <em style={{ background: 'var(--h-red)' }} />
                      <em style={{ background: 'var(--h-orange)' }} />
                      <em style={{ background: 'var(--h-yellow)' }} />
                      <em style={{ background: 'var(--h-green)' }} />
                      <em style={{ background: 'var(--h-blue)' }} />
                      <em style={{ background: 'var(--h-purple)' }} />
                    </i>
                  </span>
                </span>
                <span className="theme-name">
                  {t.name}
                  {cur === t.id && <span className="theme-check">사용 중</span>}
                </span>
                <span className="muted small">{t.note}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 계정 (비밀번호) ─────────────────────────────────────────
// 매직링크로 만든 계정에는 비밀번호가 없다. 여기서 한 번 정하면
// 이후 모든 기기에서 이메일+비밀번호로 로그인할 수 있다.
function AccountSetting() {
  const { session } = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const tooShort = pw.length > 0 && pw.length < 8
  const mismatch = pw2.length > 0 && pw !== pw2
  const canSave = pw.length >= 8 && pw === pw2 && !busy

  const save = async () => {
    setBusy(true)
    setErr(null)
    setMsg(null)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    setPw('')
    setPw2('')
    setMsg('비밀번호를 저장했습니다. 이제 다른 기기에서 이메일 + 비밀번호로 로그인할 수 있어요.')
  }

  return (
    <div className="card setting-card">
      <h3 className="card-title">계정</h3>
      <p className="muted small">
        로그인 계정: <code>{session?.user.email ?? '-'}</code>
      </p>
      <p className="muted small">
        비밀번호를 정해두면 메일을 기다리지 않고 바로 로그인할 수 있습니다. 매직링크로 만든 계정은 처음엔 비밀번호가
        없으니, <b>이 기기에서 한 번 설정</b>해 두세요.
      </p>

      <div className="snippet-form">
        <label>새 비밀번호 (8자 이상)</label>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        {tooShort && <p className="error small">8자 이상이어야 합니다.</p>}

        <label>비밀번호 확인</label>
        <input
          type="password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          placeholder="••••••••"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) void save()
          }}
        />
        {mismatch && <p className="error small">두 번 입력한 비밀번호가 다릅니다.</p>}

        {err && <p className="error small">{err}</p>}
        {msg && <p className="muted small">{msg}</p>}

        <div className="modal-actions">
          <button onClick={() => void save()} disabled={!canSave}>
            {busy ? '저장 중…' : '비밀번호 저장'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 앱 주소 (데스크톱 전용) ─────────────────────────────────
// 데스크톱 앱은 화면을 자체적으로 들고 있지 않고 배포된 웹을 그대로 띄운다.
// 그래서 UI 를 고쳐도 exe 를 다시 만들 필요가 없다 — 재배포 후 앱만 다시 열면 된다.
function AppUrlSetting() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    window.desktop?.app.getInfo().then((i) => {
      setInfo(i)
      setUrl(i.savedUrl || i.url)
    })
  }, [])

  const save = async (reload: boolean) => {
    setErr(null)
    setMsg(null)
    const r = await window.desktop?.app.setUrl(url)
    if (!r?.ok) {
      setErr(r?.error ?? '저장 실패')
      return
    }
    if (reload) {
      await window.desktop?.app.reload() // 창이 새 주소로 다시 로드된다
      return
    }
    setMsg('저장했습니다. 다음에 앱을 열 때 이 주소로 접속합니다.')
  }

  return (
    <div className="card setting-card">
      <h3 className="card-title">앱 주소</h3>
      <p className="muted small">
        데스크톱 앱은 배포된 웹을 그대로 띄웁니다. 화면을 고쳤을 땐 <code>git push</code> 후 배포가 끝나면
        앱을 다시 열기만 하면 됩니다 (설치본을 다시 만들 필요 없음).
      </p>
      <p className="muted small">
        지금 접속 중: <code>{info?.url || '…'}</code>
        {info?.isDev && ' — 개발 모드라 Vite dev 서버를 쓰는 중입니다 (저장값은 설치본에서만 적용).'}
        {info?.fromEnv && ' — MEOS_APP_URL 환경변수/.env.local 값을 쓰는 중입니다.'}
      </p>

      <div className="snippet-form">
        <label>배포 주소</label>
        <input
          type="text"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://meos.<계정>.workers.dev"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save(false)
          }}
        />
        {err && <p className="error small">{err}</p>}
        {msg && <p className="muted small">{msg}</p>}

        <div className="modal-actions">
          <button className="ghost-btn" onClick={() => void window.desktop?.app.reload(true)}>
            캐시 비우고 새로 열기
          </button>
          <button className="ghost-btn" onClick={() => void save(false)}>
            저장
          </button>
          <button onClick={() => void save(true)}>저장하고 다시 열기</button>
        </div>
        <p className="muted small">
          화면이 갱신되지 않으면 <b>Ctrl+Shift+R</b> 또는 위 “캐시 비우고 새로 열기”. 앱을 껐다 켜도 같습니다.
        </p>
      </div>
    </div>
  )
}

// ── Perforce + 사내 LLM ─────────────────────────────────────
// 워크스페이스는 Host 로 잠겨 있어(이 PC에서만 사용 가능) 쓸 수 있는 것만 위에 올려준다.
function P4Setting() {
  const [cfg, setCfg] = useState<P4Config | null>(null)
  const [workspaces, setWorkspaces] = useState<P4Workspace[]>([])
  const [models, setModels] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [onlyUsable, setOnlyUsable] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 폼 상태
  const [port, setPort] = useState('')
  const [user, setUser] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [userName, setUserName] = useState('')
  const [model, setModel] = useState('')
  const [sendDiff, setSendDiff] = useState(true)
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [llmKey, setLlmKey] = useState('')

  const load = () =>
    window.desktop?.p4.getConfig().then((c) => {
      setCfg(c)
      setPort(c.port)
      setUser(c.user)
      setWorkspace(c.workspace)
      setUserName(c.userName)
      setModel(c.model)
      setSendDiff(c.sendDiff)
      setLlmBaseUrl(c.llmBaseUrl)
    })

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const r = await window.desktop?.p4.setConfig({
      port,
      user,
      workspace,
      userName,
      model,
      sendDiff,
      llmBaseUrl,
      llmApiKey: llmKey || undefined,
    })
    setBusy(false)
    if (r?.ok) {
      setLlmKey('')
      setMsg('저장했습니다.')
      void load()
    } else {
      setMsg(r?.error ?? '저장 실패')
    }
  }

  // 워크스페이스 목록은 90개가 넘어서 필요할 때만 불러온다
  const loadWorkspaces = async () => {
    setBusy(true)
    setMsg('워크스페이스 조회 중…')
    const r = await window.desktop?.p4.workspaces()
    setBusy(false)
    if (r?.ok) {
      setWorkspaces(r.workspaces ?? [])
      const usable = (r.workspaces ?? []).filter((w) => w.usable).length
      setMsg(`${r.workspaces?.length ?? 0}개 중 이 PC(${r.hostname})에서 쓸 수 있는 것 ${usable}개`)
    } else {
      setMsg(r?.error ?? '조회 실패')
    }
  }

  const loadModels = async () => {
    setBusy(true)
    setMsg('모델 조회 중…')
    const r = await window.desktop?.llm.models()
    setBusy(false)
    if (r?.ok) {
      setModels(r.models ?? [])
      setMsg(`모델 ${r.models?.length ?? 0}개`)
    } else {
      setMsg(r?.error ?? '조회 실패')
    }
  }

  const test = async () => {
    setBusy(true)
    setMsg('접속 확인 중…')
    const r = await window.desktop?.p4.info()
    setBusy(false)
    setMsg(r?.ok ? `연결됨 — 서버 ${r.info?.serverAddress}, 사용자 ${r.info?.user}` : `실패: ${r?.error ?? ''}`)
  }

  const shown = workspaces
    .filter((w) => (onlyUsable ? w.usable : true))
    .filter((w) => !filter.trim() || w.client.toLowerCase().includes(filter.trim().toLowerCase()))
    .slice(0, 60)

  return (
    <div className="card setting-card">
      <h3 className="card-title">Perforce + 사내 LLM</h3>
      <p className="muted small">
        Pending 체인지리스트 조회와 서밋 로그 작성에 씁니다. 서밋 로그는 <b>사내 LLM</b> 에서 처리되어 코드가 회사 밖으로
        나가지 않습니다. 비워두면 이 PC의 <code>p4 set</code> 값과 <code>.env.local</code> 을 씁니다.
      </p>

      <div className="snippet-form">
        <label>서버 (P4PORT)</label>
        <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="10.10.10.223:1666" />

        <label>사용자 (P4USER)</label>
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="client" />

        <label>
          워크스페이스 {cfg?.hostname && <span className="muted small">· 이 PC: {cfg.hostname}</span>}
        </label>
        <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="client_dk_home" />

        <div className="p4-ws-tools">
          <button type="button" className="ghost-btn small-btn" onClick={() => void loadWorkspaces()} disabled={busy}>
            목록 불러오기
          </button>
          {workspaces.length > 0 && (
            <>
              <input
                className="p4-ws-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="이름으로 검색"
              />
              <label className="chk-line">
                <input type="checkbox" checked={onlyUsable} onChange={(e) => setOnlyUsable(e.target.checked)} />
                <span>이 PC에서 쓸 수 있는 것만</span>
              </label>
            </>
          )}
        </div>

        {shown.length > 0 && (
          <div className="p4-ws-list">
            {shown.map((w) => (
              <button
                key={w.client}
                type="button"
                className={`p4-ws ${workspace === w.client ? 'active' : ''} ${w.usable ? '' : 'locked'}`}
                onClick={() => setWorkspace(w.client)}
                title={w.usable ? w.root : `Host 잠금: ${w.host} 에서만 사용 가능`}
              >
                <b>{w.client}</b>
                <span className="muted small">{w.usable ? w.root || '(루트 없음)' : `🔒 ${w.host}`}</span>
              </button>
            ))}
          </div>
        )}

        <label>서밋 로그 이름 — 로그 맨 앞 [이름]</label>
        <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="김건훈" />
        <p className="muted small">
          <code>[{userName || '이름'}][컨텐츠]</code> 형태로 항상 맨 앞에 붙습니다. 같은 파일의 과거 서밋 중 이 이름이 들어간
          것에서 <b>컨텐츠명</b>과 <b>작업번호(#)</b>를 찾아 씁니다.
        </p>

        <label>LLM 주소 (Base URL)</label>
        <input
          value={llmBaseUrl}
          onChange={(e) => setLlmBaseUrl(e.target.value)}
          placeholder="https://llm.aquatree.games/v1"
        />

        <label>
          LLM API 키 {cfg?.hasLlmKey && <span className="muted small">· 저장됨 (바꿀 때만 입력)</span>}
        </label>
        <input
          type="password"
          value={llmKey}
          onChange={(e) => setLlmKey(e.target.value)}
          placeholder={cfg?.hasLlmKey ? '••••••••' : '.env.local 의 LOCAL_LLM_API_KEY 를 써도 됩니다'}
        />

        <label>모델</label>
        <div className="p4-ws-tools">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-v4-flash-m5max" />
          <button type="button" className="ghost-btn small-btn" onClick={() => void loadModels()} disabled={busy}>
            모델 목록
          </button>
        </div>
        {models.length > 0 && (
          <div className="p4-ws-list">
            {models.map((m) => (
              <button
                key={m}
                type="button"
                className={`p4-ws ${model === m ? 'active' : ''}`}
                onClick={() => setModel(m)}
              >
                <b>{m}</b>
              </button>
            ))}
          </div>
        )}

        <label className="chk-line">
          <input type="checkbox" checked={sendDiff} onChange={(e) => setSendDiff(e.target.checked)} />
          <span>서밋 로그 작성 시 변경 내용(diff)까지 보내기 — 로그가 훨씬 정확해집니다</span>
        </label>

        {msg && <p className="muted small">{msg}</p>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={() => void test()} disabled={busy}>
            연결 테스트
          </button>
          <button onClick={() => void save()} disabled={busy}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// ── AI 코드 리뷰 (Windows 전용) ─────────────────────────────
// 리뷰어를 1~N 개 등록해 두면 Perforce 화면의 “AI 리뷰” 가 그것들에게 동시에 같은 diff 를 보낸다.
//
// codex/claude 는 **CLI 를 그대로 실행**한다. API 키가 아니라 이미 로그인해 둔 구독 계정으로
// 도는 게 목적이라, main 이 자식 프로세스 환경에서 ANTHROPIC_API_KEY 같은 값을 지운다.
// 종류·모델·effort 후보 목록은 main 에서 내려받는다 — 여기에 다시 적으면 반드시 어긋난다.
function ReviewSetting() {
  const [cfg, setCfg] = useState<ReviewConfig | null>(null)
  const [reviewers, setReviewers] = useState<Reviewer[]>([])
  const [dir, setDir] = useState('')
  const [codexPath, setCodexPath] = useState('')
  const [claudePath, setClaudePath] = useState('')
  const [maxDiffChars, setMaxDiffChars] = useState(120000)
  const [timeoutMin, setTimeoutMin] = useState(15)
  const [includeNewFiles, setIncludeNewFiles] = useState(true)
  const [showPaths, setShowPaths] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () =>
    window.desktop?.review.getConfig().then((c) => {
      setCfg(c)
      setReviewers(c.reviewers)
      setDir(c.dirIsDefault ? '' : c.dir)
      setCodexPath(c.cli.codex.configured)
      setClaudePath(c.cli.claude.configured)
      setMaxDiffChars(c.maxDiffChars)
      setTimeoutMin(c.timeoutMin)
      setIncludeNewFiles(c.includeNewFiles)
    })

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const r = await window.desktop?.review.setConfig({
      dir,
      codexPath,
      claudePath,
      maxDiffChars,
      timeoutMin,
      includeNewFiles,
      reviewers,
    })
    setBusy(false)
    setMsg(r?.ok ? '저장했습니다.' : (r?.error ?? '저장 실패'))
    if (r?.ok) void load()
  }

  const patch = (id: string, next: Partial<Reviewer>) =>
    setReviewers((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)))

  const add = () => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r${Date.now()}`
    setReviewers((prev) => [...prev, { id, kind: 'local', model: '', effort: '', enabled: true }])
  }

  const pickDir = async () => {
    const r = await window.desktop?.review.pickDir()
    if (r?.ok && r.dir) setDir(r.dir)
  }

  if (!cfg) return null

  const kindOf = (k: ReviewKind) => cfg.kinds[k]
  const cliFor = (k: ReviewKind) => (k === 'codex' ? cfg.cli.codex : k === 'claude' ? cfg.cli.claude : null)

  /** 리뷰어가 지금 실제로 돌 수 있는 상태인지 — 안 되면 이유를 보여준다. */
  const blockedReason = (r: Reviewer): string | null => {
    if (r.kind === 'local') return cfg.localReady ? null : '사내 LLM 주소·키가 없습니다 (위 Perforce 설정).'
    const cli = cliFor(r.kind)
    if (!cli?.found) return `${kindOf(r.kind)?.cli} CLI 를 찾지 못했습니다. 아래에서 경로를 지정하세요.`
    return null
  }

  return (
    <div className="card setting-card">
      <h3 className="card-title">AI 코드 리뷰 (Perforce)</h3>
      <p className="muted small">
        Perforce 화면의 <b>AI 리뷰</b> 버튼이 여기 켜 둔 모델들에게 같은 diff 를 동시에 보냅니다. 결과는 md 파일로 이
        PC에 저장되고, 같은 화면의 <b>리뷰 보기</b> 에서 다시 볼 수 있습니다.
      </p>
      {!cfg.platformOk && <p className="error small">이 기능은 Windows 에서만 동작합니다.</p>}

      <div className="snippet-form">
        <label>리뷰 모델 (1개 이상)</label>
        <div className="rv-cfg-list">
          {reviewers.length === 0 && <p className="muted small">모델이 없습니다. 아래에서 추가하세요.</p>}
          {reviewers.map((r) => {
            const kind = kindOf(r.kind)
            const blocked = blockedReason(r)
            return (
              <div key={r.id} className={`rv-cfg-row ${r.enabled ? '' : 'off'}`}>
                <label className="chk-line rv-cfg-on" title="이 모델 사용">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} />
                </label>

                <select
                  value={r.kind}
                  onChange={(e) => {
                    const kindId = e.target.value as ReviewKind
                    patch(r.id, { kind: kindId, model: '', effort: cfg.kinds[kindId]?.defaultEffort ?? '' })
                  }}
                >
                  {(Object.keys(cfg.kinds) as ReviewKind[]).map((k) => (
                    <option key={k} value={k}>
                      {cfg.kinds[k].label}
                    </option>
                  ))}
                </select>

                <input
                  className="rv-cfg-model"
                  list={`rv-models-${r.kind}`}
                  value={r.model}
                  onChange={(e) => patch(r.id, { model: e.target.value })}
                  placeholder={
                    r.kind === 'local'
                      ? cfg.localModel || '사내 LLM 모델'
                      : r.kind === 'codex'
                        ? cfg.codexDefaultModel || 'codex 기본 모델'
                        : 'claude 기본 모델'
                  }
                />
                <datalist id={`rv-models-${r.kind}`}>
                  {(kind?.models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>

                {kind && kind.efforts.length > 0 ? (
                  <select value={r.effort} onChange={(e) => patch(r.id, { effort: e.target.value })}>
                    <option value="">effort 기본</option>
                    {kind.efforts.map((ef) => (
                      <option key={ef} value={ef}>
                        {ef}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="muted small rv-cfg-noeffort">effort 없음</span>
                )}

                <span className={`chip ${kind?.external ? 'rv-ext' : 'rv-int'}`}>{kind?.external ? '사외' : '사내'}</span>

                <button className="link-btn danger" onClick={() => setReviewers((p) => p.filter((x) => x.id !== r.id))}>
                  삭제
                </button>

                {blocked && <p className="error small rv-cfg-warn">{blocked}</p>}
              </div>
            )
          })}
        </div>
        <button className="sc-add-inline" onClick={add}>
          ＋ 리뷰 모델 추가
        </button>

        <p className="muted small">
          <b>사내</b> = 코드가 사내망 밖으로 나가지 않습니다. <b>사외</b> = Codex/Claude 서비스로 코드가 전송됩니다 —
          회사 코드를 보내도 되는지 확인하고 켜세요. 두 CLI 는 API 키가 아니라 <b>이미 로그인해 둔 구독 계정</b>으로
          동작합니다(<code>codex login</code> · <code>claude</code> 로그인).
        </p>

        <label>리뷰 저장 폴더</label>
        <div className="p4-ws-tools">
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder={cfg.defaultDir} />
          <button type="button" className="ghost-btn small-btn" onClick={() => void pickDir()}>
            폴더 고르기
          </button>
          <button type="button" className="ghost-btn small-btn" onClick={() => void window.desktop?.review.openDir()}>
            열기
          </button>
        </div>
        <p className="muted small">
          비우면 기본 위치를 씁니다: <code>{cfg.defaultDir}</code>. 파일 이름은{' '}
          <code>CL29580_20260814-153012.md</code> 처럼 리뷰한 시각이 들어갑니다.
        </p>

        <div className="rv-cfg-nums">
          <label>
            diff 최대 길이 (자)
            <input
              type="number"
              min={10000}
              max={800000}
              step={10000}
              value={maxDiffChars}
              // 빈칸이면 Number('')=0 이라 min 아래로 떨어진다 — 지우는 중일 뿐이니 값을 건드리지 않는다
              onChange={(e) => e.target.value !== '' && setMaxDiffChars(Number(e.target.value))}
            />
          </label>
          <label>
            제한 시간 (분)
            <input
              type="number"
              min={1}
              max={60}
              value={timeoutMin}
              onChange={(e) => e.target.value !== '' && setTimeoutMin(Number(e.target.value))}
            />
          </label>
        </div>
        <label className="chk-line">
          <input type="checkbox" checked={includeNewFiles} onChange={(e) => setIncludeNewFiles(e.target.checked)} />
          <span>새로 추가한 파일의 본문도 보내기 — add 파일은 diff 가 안 나와서 이걸 꺼두면 이름만 갑니다</span>
        </label>

        <button className="link-btn rv-cfg-toggle" onClick={() => setShowPaths((v) => !v)}>
          {showPaths ? '▾' : '▸'} CLI 경로 {cfg.cli.codex.found && cfg.cli.claude.found ? '(자동으로 찾음)' : '(확인 필요)'}
        </button>
        {showPaths && (
          <>
            {(['codex', 'claude'] as const).map((k) => {
              const cli = cfg.cli[k]
              return (
                <div key={k}>
                  <label>
                    {cfg.kinds[k].label} 실행 파일{' '}
                    {cli.found ? (
                      <span className="muted small">· {cli.source === 'setting' ? '설정값' : `${cli.source} 에서 찾음`}</span>
                    ) : (
                      <span className="error small">· 찾지 못함</span>
                    )}
                  </label>
                  <input
                    value={k === 'codex' ? codexPath : claudePath}
                    onChange={(e) => (k === 'codex' ? setCodexPath : setClaudePath)(e.target.value)}
                    placeholder={cli.path || `${k}.exe 전체 경로`}
                    spellCheck={false}
                  />
                </div>
              )
            })}
            <p className="muted small">비워두면 PATH 와 npm 전역 설치 위치에서 자동으로 찾습니다.</p>
          </>
        )}

        {msg && <p className="muted small">{msg}</p>}
        <div className="modal-actions">
          <button onClick={() => void save()} disabled={busy}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// ── BTS (Redmine / JIRA) 접속 정보 ──────────────────────────
// 회사 업무 토큰은 데스크톱에만 보관한다 (OS 암호화 safeStorage). 저장된 비밀값은 화면에
// 다시 표시하지 않고, 빈칸으로 두면 기존 값을 유지한다.
function BtsSetting() {
  const [cfg, setCfg] = useState<BtsConfig | null>(null)
  const [redmineUrl, setRedmineUrl] = useState('')
  const [redmineKey, setRedmineKey] = useState('')
  const [insecure, setInsecure] = useState(false)
  const [jiraUrl, setJiraUrl] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraToken, setJiraToken] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () =>
    window.desktop?.bts.getConfig().then((c) => {
      setCfg(c)
      setRedmineUrl(c.redmine.url)
      setInsecure(c.redmine.insecure)
      setJiraUrl(c.jira.url)
      setJiraEmail(c.jira.email)
    })

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    const r = await window.desktop?.bts.setConfig({
      redmine: { url: redmineUrl, apiKey: redmineKey || undefined, insecure },
      jira: { url: jiraUrl, email: jiraEmail, token: jiraToken || undefined },
    })
    setBusy(false)
    if (r?.ok) {
      setRedmineKey('')
      setJiraToken('')
      setMsg('저장했습니다. 업무 화면에서 새로고침하면 반영됩니다.')
      void load()
    } else {
      setMsg(r?.error ?? '저장 실패')
    }
  }

  const test = async () => {
    setBusy(true)
    setMsg('조회 중…')
    try {
      const res = await window.desktop?.bts.fetch()
      if (!res) return
      const parts: string[] = []
      for (const [name, s] of [
        ['Redmine', res.sources.redmine],
        ['JIRA', res.sources.jira],
      ] as const) {
        if (!s.configured) parts.push(`${name}: 미설정`)
        else if (s.error) parts.push(`${name}: 실패 — ${s.error}`)
        else parts.push(`${name}: ${s.count}건`)
      }
      setMsg(parts.join(' · '))
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card setting-card">
      <h3 className="card-title">BTS 연결 (Redmine / JIRA)</h3>
      <p className="muted small">
        내 담당 이슈를 업무 화면에 실시간으로 표시합니다. 접속 정보는 이 PC에만 OS 암호화로 저장되며 클라우드로
        전송하지 않습니다. 저장소 루트 <code>.env.local</code> 의 값(REDMINE_URL 등)이 있으면 폴백으로 사용합니다.
      </p>
      {cfg && !cfg.encryptionAvailable && <p className="error small">이 PC에서 OS 암호화를 쓸 수 없어 비밀값을 저장할 수 없습니다.</p>}

      <div className="snippet-form">
        <label>Redmine 주소</label>
        <input value={redmineUrl} onChange={(e) => setRedmineUrl(e.target.value)} placeholder="https://redmine.사내주소" />
        <label>Redmine API 키 {cfg?.redmine.hasKey && <span className="muted small">· 저장됨 (바꿀 때만 입력)</span>}</label>
        <input
          type="password"
          value={redmineKey}
          onChange={(e) => setRedmineKey(e.target.value)}
          placeholder={cfg?.redmine.hasKey ? '••••••••' : '내 계정 → API 액세스 키'}
        />
        <label className="chk-line">
          <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
          <span>사설 인증서 허용 (사내 HTTPS 인증서 오류가 날 때만 켜기)</span>
        </label>

        <label>JIRA 주소</label>
        <input value={jiraUrl} onChange={(e) => setJiraUrl(e.target.value)} placeholder="https://회사.atlassian.net" />
        <label>JIRA 이메일</label>
        <input value={jiraEmail} onChange={(e) => setJiraEmail(e.target.value)} placeholder="me@company.com" />
        <label>JIRA API 토큰 {cfg?.jira.hasToken && <span className="muted small">· 저장됨 (바꿀 때만 입력)</span>}</label>
        <input
          type="password"
          value={jiraToken}
          onChange={(e) => setJiraToken(e.target.value)}
          placeholder={cfg?.jira.hasToken ? '••••••••' : 'id.atlassian.com → API 토큰'}
        />

        {msg && <p className="muted small">{msg}</p>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={() => void test()} disabled={busy}>
            연결 테스트
          </button>
          <button onClick={() => void save()} disabled={busy}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// e.key → Electron accelerator 키 이름
function toAccelKey(key: string): string | null {
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  const map: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
  }
  if (map[key]) return map[key]
  if (/^F\d{1,2}$/.test(key)) return key
  return null
}

function HotkeySetting() {
  const [hotkey, setHotkey] = useState('')
  const [recording, setRecording] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    window.desktop?.settings.getHotkey().then(setHotkey)
  }, [])

  const onRecordKey = async (e: KeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault()
    const key = e.key
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return // 수정키만 → 대기
    const mods: string[] = []
    if (e.ctrlKey) mods.push('Control')
    if (e.shiftKey) mods.push('Shift')
    if (e.altKey) mods.push('Alt')
    if (e.metaKey) mods.push('Super')
    const accelKey = toAccelKey(key)
    if (!accelKey) {
      setMsg('지원하지 않는 키예요. 다른 조합을 눌러보세요.')
      return
    }
    if (mods.length === 0) {
      setMsg('수정키(Ctrl/Shift/Alt)를 하나 이상 포함하세요.')
      return
    }
    const accel = [...mods, accelKey].join('+')
    setRecording(false)
    const r = await window.desktop?.settings.setHotkey(accel)
    if (r?.ok) {
      setHotkey(accel)
      setMsg(`저장됨: ${accel}`)
    } else {
      setMsg(`등록 실패: ${r?.error ?? ''} — 다른 조합을 시도하세요.`)
    }
  }

  return (
    <div className="card setting-card">
      <h3 className="card-title">Quick Search 단축키</h3>
      <p className="muted small">전역 단축키 — 앱이 트레이에 있어도 이 조합으로 검색창이 열립니다.</p>
      <div className="hotkey-row">
        <code className="hotkey-cur">{hotkey || '…'}</code>
        <button
          className={`ghost-btn ${recording ? 'recording' : ''}`}
          onClick={() => {
            setRecording(true)
            setMsg('조합을 누르세요… (예: Ctrl+Shift+Space)')
          }}
          onKeyDown={recording ? onRecordKey : undefined}
        >
          {recording ? '입력 대기 중…' : '단축키 변경'}
        </button>
      </div>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  )
}

function SnippetManager() {
  const [list, setList] = useState<{ id: string; title: string }[]>([])
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const reload = () => window.desktop?.snippets.list().then(setList)
  useEffect(() => {
    reload()
  }, [])

  const startEdit = async (s: { id: string; title: string }) => {
    const r = await window.desktop?.snippets.reveal(s.id)
    setEditing({ id: s.id, title: s.title, content: r?.ok ? r.content ?? '' : '' })
    setMsg(null)
  }
  const copy = async (id: string) => {
    const r = await window.desktop?.snippets.copy(id)
    if (r?.ok) {
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(null), 1500)
    }
  }
  const save = async () => {
    if (!editing) return
    const r = await window.desktop?.snippets.save(editing)
    if (r?.ok) {
      setEditing(null)
      setMsg(null)
      reload()
    } else {
      setMsg(r?.error ?? '저장 실패')
    }
  }
  const remove = async (id: string) => {
    await window.desktop?.snippets.remove(id)
    reload()
  }

  return (
    <div className="card setting-card">
      <h3 className="card-title">스니펫</h3>
      <p className="muted small">
        제목·내용을 등록하면 Quick Search에서 제목을 검색해 내용을 클립보드로 복사합니다. 내용은 OS 암호화(safeStorage)로
        저장됩니다.
      </p>

      <div className="snippet-list">
        {list.length === 0 && <p className="muted small">등록된 스니펫이 없어요.</p>}
        {list.map((s) => (
          <div key={s.id} className="snippet-row">
            <span className="snippet-title">{s.title}</span>
            <button className="icon-btn" title="복사" onClick={() => void copy(s.id)}>
              {copiedId === s.id ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              )}
            </button>
            <button className="link-btn" onClick={() => void startEdit(s)}>
              수정
            </button>
            <button className="link-btn danger" onClick={() => void remove(s.id)}>
              삭제
            </button>
          </div>
        ))}
      </div>

      {editing ? (
        <div className="snippet-form">
          <label>제목</label>
          <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="예: 아쿠아트리 암호" />
          <label>내용</label>
          <textarea
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            placeholder="복사할 내용"
            rows={3}
          />
          {msg && <p className="error small">{msg}</p>}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => { setEditing(null); setMsg(null) }}>
              취소
            </button>
            <button onClick={() => void save()} disabled={!editing.title.trim()}>
              저장
            </button>
          </div>
        </div>
      ) : (
        <button className="sc-add-inline" onClick={() => setEditing({ title: '', content: '' })}>
          ＋ 스니펫 추가
        </button>
      )}
    </div>
  )
}
