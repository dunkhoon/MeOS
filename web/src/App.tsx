import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { AppShell } from './components/AppShell'
import { TitleBar } from './components/TitleBar'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Calendar from './pages/Calendar'
import Tasks from './pages/Tasks'
import Exercise from './pages/Exercise'
import Report from './pages/Report'
import Perforce from './pages/Perforce'
import Trash from './pages/Trash'
import Settings from './pages/Settings'

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
              <Route path="/report" element={<Report />} />
              <Route path="/perforce" element={<Perforce />} />
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
