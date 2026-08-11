export default function Dashboard() {
  return (
    <div className="page">
      <header className="page-head">
        <h2>대시보드</h2>
        <p className="muted">오늘 일정 · 마감 업무 · 훈련부하 · 컨디션 요약</p>
      </header>
      <div className="grid">
        <div className="card placeholder">
          오늘/이번주 일정 <span className="soon">준비중</span>
        </div>
        <div className="card placeholder">
          마감·진행 업무 <span className="soon">PC 전용 · 준비중</span>
        </div>
        <div className="card placeholder">
          훈련부하 · 최근 활동 <span className="soon">준비중</span>
        </div>
        <div className="card placeholder">
          컨디션 요약 <span className="soon">준비중</span>
        </div>
      </div>
    </div>
  )
}
