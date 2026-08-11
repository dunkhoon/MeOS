// intervals.icu → Supabase 동기화 (CLI)
// 실행:  node scripts/sync-intervals.mjs   (또는 sync-intervals.bat)
// 로직은 sync-core.mjs 공용. 로컬 동기화 서버(server/sync-server.mjs)도 같은 코어 사용.

import { runSync } from './sync-core.mjs'

console.log('[동기화] intervals.icu → Supabase')
runSync((m) => console.log('  ' + m))
  .then((r) => console.log(`[완료] 활동 ${r.activities} · 웰니스 ${r.wellness} · 대회 ${r.races}`))
  .catch((e) => {
    console.error('[실패]', e.message)
    process.exit(1)
  })
