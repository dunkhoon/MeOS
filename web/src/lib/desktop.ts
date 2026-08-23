// 지금 이 화면이 데스크톱 앱(Electron)인가.
//
// `window.desktop` 은 Electron preload 가 넣어 주는 브리지다. 브라우저·모바일에는 없다.
// preload 는 렌더러 스크립트보다 먼저 도므로 언제 물어봐도 값이 나와 있다.
//
// ⚠️ 이 판정을 각 파일에서 `!!window.desktop?.isDesktop` 로 따로 쓰지 말 것. 여섯 군데에
//    흩어져 있었고, 그러면 한 곳을 고칠 때 나머지가 조용히 어긋난다. 한 벌만 둔다.
//
// PC 전용 기능은 **감추는 것으로 끝내지 않는다.** 화면 목록에서 빼고, 경로도 등록하지 않는다
// (주소를 직접 쳐도 못 들어간다). 브라우저에서는 그 기능이 아예 없는 것처럼 보이는 게 맞다 —
// 쓸 수 없는 걸 보여 주고 "PC 전용입니다" 라고 말하는 건 자리만 차지한다.
export function isDesktop(): boolean {
  return !!window.desktop?.isDesktop
}
