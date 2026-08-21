import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { AppShell } from './components/AppShell'
import { TitleBar } from './components/TitleBar'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Calendar from './pages/Calendar'
import Tasks from './pages/Tasks'
import Exercise from './pages/Exercise'
import ActivityDetail from './pages/ActivityDetail'
import Report from './pages/Report'
import Perforce from './pages/Perforce'
import Disk from './pages/Disk'
import Trash from './pages/Trash'
import Settings from './pages/Settings'
import Assistant from './pages/Assistant'

export default function App() {
  const { session, loading } = useAuth()

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-body">
        {loading ? (
          <div className="center-screen muted">불러오는 중…</div>
        ) : !session ? (
          <Routes>
            <Route path="*" element={<Login />} />
          </Routes>
        ) : (
          <AppShell>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/exercise" element={<Exercise />} />
              {/* 서브탭(활동·근력·체형) 은 주소에 남긴다 — 뒤로가기·링크·새로고침이 다 살아난다 */}
              <Route path="/exercise/:tab" element={<Exercise />} />
              <Route path="/activity/:id" element={<ActivityDetail />} />
              <Route path="/assistant" element={<Assistant />} />
              <Route path="/report" element={<Report />} />
              <Route path="/perforce" element={<Perforce />} />
              <Route path="/disk" element={<Disk />} />
              <Route path="/trash" element={<Trash />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
        )}
      </div>
    </div>
  )
}
