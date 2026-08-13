"""Pretendard 서브셋 만들기 (오프라인에서도 서체가 유지되도록 앱에 같이 넣는다).

전체 가변 폰트는 2MB 라 PWA 에 통째로 넣기엔 부담스럽다. 실제로 쓸 글자만 남긴다:
  · KS X 1001 완성형 한글 2350자 (일상 한국어는 사실상 전부 커버)
  · 소스에 실제로 등장하는 한글 (2350자 밖 글자까지 확실히 포함)
  · 라틴·숫자·문장부호·화살표·도형 등 UI 기호

굵기 축(wght 45~930)은 그대로 남기므로 파일 하나로 9단계를 다 쓴다.

    pip install fonttools brotli
    python scripts/make-font-subset.py
"""

import io
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "node_modules/pretendard/dist/public/variable/PretendardVariable.ttf"
OUT = ROOT / "web/src/assets/fonts/pretendard-subset.woff2"

# 1) KS X 1001 완성형 2350자.
#    ⚠️ 'euc_kr' 로 거르면 안 된다 — 파이썬의 euc_kr 은 완성형에 없는 글자를 8바이트 조합형으로
#    인코딩해 버려서 11172자가 전부 통과한다. 'iso2022_kr' 이 정확히 2350자만 받는다.
ks = []
for cp in range(0xAC00, 0xD7A4):
    ch = chr(cp)
    try:
        ch.encode("iso2022_kr")
    except UnicodeEncodeError:
        continue
    ks.append(ch)

# 2) 소스에 실제로 쓰인 글자 — 2350자 밖이어도 화면에 뜨는 건 빠지면 안 된다
used = set()
for pat in ("web/src/**/*.ts", "web/src/**/*.tsx", "web/src/**/*.css", "web/index.html", "electron/*.js", "electron/*.html"):
    for f in ROOT.glob(pat):
        used |= set(io.open(f, encoding="utf-8", errors="ignore").read())
hangul_used = {c for c in used if "가" <= c <= "힣"}

chars = "".join(sorted(set(ks) | hangul_used))
(ROOT / "scripts/.font-chars.txt").write_text(chars, encoding="utf-8")
print(f"한글 {len(chars)}자 (완성형 {len(ks)} + 소스 전용 {len(hangul_used - set(ks))})")

UNICODES = ",".join([
    "U+0020-007E",   # 기본 라틴
    "U+00A0-00FF",   # 라틴-1 (°, ±, ×, ·)
    "U+2010-2027",   # 붙임표·따옴표·말줄임표
    "U+2030-205E",   # ‰, ′, ″, ※
    "U+20A9,U+20AC", # ₩, €
    "U+2190-21BB",   # 화살표
    "U+2200-22FF",   # 수학 기호 (≥, ≤, ≈)
    "U+2460-24FF",   # ①②③
    "U+25A0-25FF",   # ■ ▶ ▾ ● ○
    "U+2600-26FF",   # 기타 기호
    "U+3000-303F",   # CJK 문장부호
    "U+3131-318E",   # 호환 자모 (ㄱ, ㅋ)
    "U+FF01-FF5E",   # 전각
])

if not SRC.exists():
    sys.exit(f"원본이 없습니다: {SRC}\n  npm i -w web pretendard 를 먼저 실행하세요.")

OUT.parent.mkdir(parents=True, exist_ok=True)
cmd = [
    sys.executable, "-m", "fontTools.subset", str(SRC),
    f"--output-file={OUT}", "--flavor=woff2",
    f"--text-file={ROOT / 'scripts/.font-chars.txt'}",
    f"--unicodes={UNICODES}",
    "--layout-features=kern,liga,calt,tnum,case",
    "--no-hinting", "--desubroutinize",
    "--name-IDs=1,2,3,4,5,6",
]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode != 0:
    sys.exit(r.stderr[-800:])

print(f"{SRC.stat().st_size // 1024} KB  ->  {OUT.stat().st_size // 1024} KB  ({OUT.relative_to(ROOT)})")
