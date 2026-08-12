#!/usr/bin/env node
// MeOS 훈련 창구 CLI — OpenClaw 스킬이 exec 로 부른다.
//
//   node meos.mjs today            오늘(없으면 가장 최근) 훈련의 분석 자료
//   node meos.mjs recent [N]       최근 훈련 목록
//   node meos.mjs get <활동id>     특정 훈련의 분석 자료
//   node meos.mjs post <활동id>    분석 결과 올리기 (본문은 **stdin** 으로)
//        옵션: --model <이름>  --source <이름>
//
// 본문을 인자가 아니라 stdin 으로 받는 이유: 여러 줄 한국어를 명령줄에 넣으면
// 따옴표·개행·인코딩에서 반드시 깨진다 (윈도우에서 특히).
//
// 필요 환경변수
//   MEOS_NOTE_TOKEN   MeOS Edge Function 공유 토큰 (필수)
//   MEOS_NOTE_URL     기본값 아래 BASE — 프로젝트가 다르면 지정

const BASE = process.env.MEOS_NOTE_URL || 'https://ggtnaqmmdjcfhkqzjhty.supabase.co/functions/v1/note'
const TOKEN = process.env.MEOS_NOTE_TOKEN

// process.exit() 로 즉시 끊으면 파이프로 stdin 을 받은 뒤 윈도우 Node 가
// "Assertion failed: UV_HANDLE_CLOSING" 을 뱉는다. 던지고 위에서 받아 정상 종료한다.
class Fail extends Error {}
function die(msg) {
  throw new Fail(msg)
}

const headers = { 'x-meos-token': TOKEN, 'Content-Type': 'application/json; charset=utf-8' }

async function call(path, init) {
  let res
  try {
    res = await fetch(BASE + path, { ...init, headers })
  } catch (e) {
    die(`MeOS 에 연결하지 못했습니다: ${e.message}`)
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    die(`응답이 JSON 이 아닙니다 (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok || body.ok === false) die(body.error || `HTTP ${res.status}`)
  return body
}

/** 로컬 날짜 YYYY-MM-DD */
const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** stdin 을 UTF-8 로 전부 읽는다 (파이프가 없으면 빈 문자열) */
async function readStdin() {
  if (process.stdin.isTTY) return ''
  process.stdin.setEncoding('utf8')
  let out = ''
  for await (const chunk of process.stdin) out += chunk
  return out
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!TOKEN) die('MEOS_NOTE_TOKEN 환경변수가 없습니다. openclaw.json 또는 셸에서 설정하세요.')
  const arg = (name) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))

  switch (cmd) {
    case 'recent': {
      const n = Number(positional[0]) || 10
      const { activities } = await call('?recent=1')
      console.log(JSON.stringify(activities.slice(0, n), null, 1))
      break
    }

    case 'today': {
      const { activities } = await call('?recent=1')
      const today = ymd()
      // 오늘 것이 없으면 가장 최근 훈련으로 — "오늘 훈련 어때?" 를 저녁 늦게/다음날 새벽에 물어도 통하게
      const pick = activities.find((a) => (a.start_date_local ?? '').slice(0, 10) === today) ?? activities[0]
      if (!pick) die('활동이 없습니다. MeOS 동기화가 됐는지 확인하세요.')
      const detail = await call(`?id=${encodeURIComponent(pick.external_id)}`)
      console.log(
        JSON.stringify(
          { isToday: (pick.start_date_local ?? '').slice(0, 10) === today, ...detail },
          null,
          1,
        ),
      )
      break
    }

    case 'get': {
      const id = positional[0]
      if (!id) die('활동 id 가 필요합니다. 예: node meos.mjs get i174540791')
      console.log(JSON.stringify(await call(`?id=${encodeURIComponent(id)}`), null, 1))
      break
    }

    case 'post': {
      const id = positional[0]
      if (!id) die('활동 id 가 필요합니다. 예: node meos.mjs post i174540791 < analysis.txt')
      const content = (await readStdin()).trim()
      if (!content) die('본문이 비었습니다. 분석 내용을 stdin 으로 넘기세요 (파이프 또는 << EOF).')
      const body = { id, content, model: arg('model'), source: arg('source') || 'openclaw' }
      const r = await call('', { method: 'POST', body: JSON.stringify(body) })
      console.log(`[meos] 올렸습니다: ${r.saved} (${content.length}자)`)
      break
    }

    default:
      console.log(
        [
          'MeOS 훈련 창구',
          '',
          '  node meos.mjs today                 오늘(없으면 최근) 훈련 자료',
          '  node meos.mjs recent [N]            최근 훈련 목록',
          '  node meos.mjs get <활동id>          특정 훈련 자료',
          '  node meos.mjs post <활동id>         분석 올리기 (본문은 stdin)',
          '        --model <이름>  --source <이름>',
        ].join('\n'),
      )
      if (cmd) process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(`[meos] ${e instanceof Fail ? e.message : e?.message || e}`)
  process.exitCode = 1
})
