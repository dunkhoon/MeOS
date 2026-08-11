import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type Status = 'idle' | 'sending' | 'sent' | 'error'

export default function Login() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setStatus('sending')
    setError('')
    // Electron 창에서는 딥링크 스킴으로, 브라우저에서는 현재 origin 으로 리다이렉트
    const emailRedirectTo = window.desktop?.isDesktop ? 'privateplanner://auth' : window.location.origin
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo },
    })
    if (error) {
      setStatus('error')
      setError(error.message)
    } else {
      setStatus('sent')
    }
  }

  return (
    <div className="center-screen">
      <div className="login-card">
        <h1 className="brand">MeOS</h1>
        <p className="muted small">Personal OS · 매직링크 로그인</p>
        {status === 'sent' ? (
          <p className="notice">
            ✉️ <strong>{email}</strong> 로 로그인 링크를 보냈어요.
            <br />
            메일함에서 링크를 눌러 로그인하세요.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="login-form">
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" disabled={status === 'sending'}>
              {status === 'sending' ? '보내는 중…' : '로그인 링크 받기'}
            </button>
            {status === 'error' && <p className="error">{error}</p>}
          </form>
        )}
      </div>
    </div>
  )
}
