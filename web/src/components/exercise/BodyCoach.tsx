import { CollapsibleCard } from '../CollapsibleCard'
import { AskButton } from '../AskButton'
import { MODE_LABEL, type CoachPlan } from '../../lib/coach'

// 목표에서 나온 "오늘 이렇게" — 전부 공식으로 뽑은 값이다.
// 근거를 접어 두지 않고 같이 보여 준다. 숫자만 있으면 믿고 따르기가 어렵다.

export function BodyCoach({ plan }: { plan: CoachPlan }) {
  const has = plan.targetKcal != null
  return (
    <CollapsibleCard
      id="ex-body-coach"
      title={
        <>
          <span className="sec-dot" /> 조정 방법
        </>
      }
      actions={
        <div className="bc-actions">
          <span className={`chip mode-${plan.mode}`}>{MODE_LABEL[plan.mode]}</span>
          {/* 규칙이 뽑은 수치를 그대로 실어 보낸다 — 에이전트는 해석과 조정만 하면 된다 */}
          <AskButton
            question="지금 목표랑 최근 기록 보고, 이번 주에 뭘 어떻게 조정하면 좋을지 알려줘."
            context={{
              모드: MODE_LABEL[plan.mode],
              유지칼로리: plan.tdee,
              목표칼로리: plan.targetKcal,
              단백질g: plan.proteinG,
              탄수g: plan.carbG,
              지방g: plan.fatG,
              주당필요변화kg: plan.neededKgPerWeek,
              근력: { 실제: plan.actualStrengthPerWeek, 권장: plan.strengthPerWeek },
              유산소분: { 실제: plan.actualCardioMinPerWeek, 권장: plan.cardioMinPerWeek },
              규칙기반조언: plan.advice.map((a) => `[${a.level}] ${a.text}`),
            }}
          />
        </div>
      }
    >
      {has ? (
        <>
          <div className="bc-macros">
            <div className="bc-macro main">
              <div className="bc-macro-val">{plan.targetKcal?.toLocaleString()}</div>
              <div className="bc-macro-label">
                kcal / 일
                {plan.deltaKcal != null && plan.deltaKcal !== 0 && (
                  <span className={plan.deltaKcal < 0 ? 'delta-down' : 'delta-up'}>
                    {' '}
                    유지 대비 {plan.deltaKcal > 0 ? '+' : ''}
                    {plan.deltaKcal}
                  </span>
                )}
              </div>
            </div>
            <div className="bc-macro">
              <div className="bc-macro-val">{plan.proteinG ?? '-'}g</div>
              <div className="bc-macro-label">단백질</div>
            </div>
            <div className="bc-macro">
              <div className="bc-macro-val">{plan.carbG ?? '-'}g</div>
              <div className="bc-macro-label">탄수화물</div>
            </div>
            <div className="bc-macro">
              <div className="bc-macro-val">{plan.fatG ?? '-'}g</div>
              <div className="bc-macro-label">지방</div>
            </div>
          </div>

          <div className="bc-basis muted small">
            유지 <b>{plan.tdee?.toLocaleString()}</b>kcal = 기초대사 {plan.bmr?.toLocaleString()} × 생활 계수 + 운동{' '}
            {plan.exerciseKcal?.toLocaleString()}kcal(최근 4주 평균)
            {plan.neededKgPerWeek != null && plan.neededKgPerWeek !== 0 && (
              <>
                {' '}
                · 목표 속도 주당 {plan.neededKgPerWeek > 0 ? '+' : ''}
                {plan.neededKgPerWeek}kg
              </>
            )}
          </div>

          <div className="bc-train">
            <TrainRow
              label="근력"
              actual={`주 ${plan.actualStrengthPerWeek}회`}
              target={`주 ${plan.strengthPerWeek}회`}
              ok={plan.actualStrengthPerWeek + 0.4 >= plan.strengthPerWeek}
            />
            <TrainRow
              label="유산소"
              actual={`주 ${plan.actualCardioMinPerWeek}분`}
              target={`주 ${plan.cardioMinPerWeek}분`}
              ok={plan.actualCardioMinPerWeek >= plan.cardioMinPerWeek * 0.7}
            />
          </div>
        </>
      ) : (
        <p className="muted small">인바디 측정과 목표가 있으면 여기에 하루 섭취량과 운동량이 계산됩니다.</p>
      )}

      {plan.advice.length > 0 && (
        <ul className="bc-advice">
          {plan.advice.map((a, i) => (
            <li key={i} className={`bc-adv ${a.level}`}>
              <span className="bc-adv-mark">{a.level === 'warn' ? '!' : a.level === 'good' ? '✓' : 'i'}</span>
              {a.text}
            </li>
          ))}
        </ul>
      )}
    </CollapsibleCard>
  )
}

function TrainRow({ label, actual, target, ok }: { label: string; actual: string; target: string; ok: boolean }) {
  return (
    <div className="bc-train-row">
      <span className="bc-train-label">{label}</span>
      <span className={ok ? 'delta-up' : 'delta-down'}>{actual}</span>
      <span className="muted small">권장 {target}</span>
    </div>
  )
}
