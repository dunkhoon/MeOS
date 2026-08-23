import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { isDesktop } from '../lib/desktop'

// 로그인은 이메일 + 비밀번호가 기본이다.
// (매직링크는 Supabase 기본 메일 발송 한도가 시간당 몇 통뿐이라 실사용에 부적합했다)
// 비밀번호를 아직 안 정했거나 잊었을 때를 위해 메일 링크를 복구 수단으로 남겨 둔다.

type Mode = 'password' | 'magic'
type Status = 'idle' | 'busy' | 'sent' | 'error'

export default function Login() {
  const [mode, setMode] = useState<Mode>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus('busy')
    setError('')

    if (mode === 'password') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setStatus('error')
        // Supabase 메시지가 영어라 흔한 것만 한국어로 바꿔 준다
        setError(
          /invalid login credentials/i.test(error.message)
            ? '이메일 또는 비밀번호가 맞지 않습니다. 비밀번호를 정한 적이 없다면 아래 메일 링크로 로그인하세요.'
            : error.message,
        )
      } else {
        setStatus('idle') // 성공하면 세션이 잡히며 화면이 전환된다
      }
      return
    }

    // 복구용 — 매직링크
    const emailRedirectTo = isDesktop() ? 'privateplanner://auth' : window.location.origin
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } })
    if (error) {
      setStatus('error')
      setError(
        /rate limit/i.test(error.message)
          ? '메일 발송 한도를 넘었습니다. 1시간쯤 뒤에 다시 시도하거나, 이미 로그인된 기기의 설정 → 계정에서 비밀번호를 정하세요.'
          : error.message,
      )
    } else {
      setStatus('sent')
    }
  }

  return (
    <div className="center-screen">
      <div className="login-card">
        <h1 className="brand">MeOS</h1>
        <p className="muted small">Personal OS</p>

        {status === 'sent' ? (
          <p className="notice">
            ✉️ <strong>{email}</strong> 로 로그인 링크를 보냈어요.
            <br />
            메일함에서 링크를 눌러 로그인하세요.
          </p>
        ) : (
          <form onSubmit={submit} className="login-form">
            <input
              type="email"
              required
              autoComplete="username"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            {mode === 'password' && (
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}

            <button type="submit" disabled={status === 'busy'}>
              {status === 'busy' ? '확인 중…' : mode === 'password' ? '로그인' : '로그인 링크 받기'}
            </button>

            {status === 'error' && <p className="error">{error}</p>}

            <button
              type="button"
              className="link-btn login-alt"
              onClick={() => {
                setMode(mode === 'password' ? 'magic' : 'password')
                setStatus('idle')
                setError('')
              }}
            >
              {mode === 'password' ? '비밀번호를 모르시나요? 메일 링크로 로그인' : '비밀번호로 로그인'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
