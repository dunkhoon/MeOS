"""Garmin Connect 최초 1회 로그인 → 토큰 저장 (러닝화 정보용).

왜 Python 인가: Garmin 이 2026-03 에 인증 방식을 바꿔 기존 방법(garth)이 막혔고,
지금 다시 동작하는 건 python-garminconnect 뿐이다. **로그인 1회만** 여기서 하고,
그 뒤 조회는 저장된 토큰으로 Supabase Edge Function(Deno)이 한다 → 모바일에서도 보인다.

저장되는 토큰은 세 줄짜리 JSON 이다 (di_token / di_refresh_token / di_client_id).
비밀번호는 저장되지 않는다. 갱신은 diauth.garmin.com 에 HTTP POST 한 번이면 되므로
이후로는 Python 이 필요 없다.

준비:  pip install -U garminconnect
실행:  python scripts/garmin-login.py
"""

import json
import os
import sys
from getpass import getpass

try:
    from garminconnect import Garmin
except ImportError:
    print("[!] garminconnect 가 없습니다.  pip install -U garminconnect")
    sys.exit(1)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "garmin-tokens.json")


def main() -> int:
    try:
        import importlib.metadata as md

        print(f"garminconnect {md.version('garminconnect')}")
    except Exception:
        pass

    email = input("Garmin 이메일: ").strip()
    password = getpass("비밀번호 (화면에 안 보입니다): ")

    def ask_mfa() -> str:
        return input("MFA 코드: ").strip()

    print("\n로그인 중…")
    try:
        api = Garmin(email=email, password=password, prompt_mfa=ask_mfa)
        api.login()
    except Exception as e:
        print(f"\n[실패] {type(e).__name__}: {e}")
        print("  · 비밀번호 / MFA 코드를 확인하세요.")
        print("  · pip install -U garminconnect 로 최신판을 받아 다시 시도해 보세요.")
        print("  · 그래도 안 되면 Garmin 이 또 인증을 바꾼 것일 수 있습니다 (2026-03 전례).")
        return 1

    print("[OK] 로그인 성공")

    # 토큰(JSON 문자열) — 이 값을 Supabase 시크릿에 넣으면 이후 조회는 서버가 한다
    try:
        tokens = api.client.dumps()
        json.loads(tokens)  # 형식 확인
    except Exception as e:
        print(f"[실패] 토큰 직렬화 실패: {e}")
        return 1

    out = os.path.abspath(OUT)
    with open(out, "w", encoding="utf-8") as f:
        f.write(tokens)
    try:
        os.chmod(out, 0o600)
    except Exception:
        pass
    keys = sorted(json.loads(tokens).keys())
    print(f"[OK] 토큰 저장: {out}")
    print(f"     담긴 항목: {', '.join(keys)}  (비밀번호 없음)")

    # ── 신발 조회 — 이게 나오면 MeOS 에 붙일 수 있다는 뜻 ──
    print("\n신발(Gear) 조회 중…")
    profile_no = None
    try:
        prof = api.get_user_profile()
        for k in ("profileId", "userProfileId", "id", "profileNumber"):
            if isinstance(prof, dict) and prof.get(k):
                profile_no = prof[k]
                break
    except Exception as e:
        print(f"  프로필 조회 실패: {e}")

    if not profile_no:
        try:
            profile_no = api.profile.get("profileId")  # type: ignore[attr-defined]
        except Exception:
            pass

    print(f"  profile number: {profile_no}")
    if not profile_no:
        print("[!] 프로필 번호를 못 찾았습니다. 위 출력을 그대로 알려주세요.")
        return 1

    try:
        gear = api.get_gear(profile_no)
    except Exception as e:
        print(f"[실패] 신발 조회 실패: {type(e).__name__}: {e}")
        print("  로그인·토큰은 됐으니 절반은 성공입니다. 이 메시지를 알려주세요.")
        return 1

    if not gear:
        print("[!] 등록된 신발이 없습니다. Garmin Connect 에서 장비를 먼저 등록하세요.")
        return 0

    print(f"\n[OK] 신발 {len(gear)}개")
    for g in gear:
        print(
            "  •",
            json.dumps(
                {
                    k: g.get(k)
                    for k in ("uuid", "displayName", "customMakeModel", "gearTypeName", "gearStatusName", "dateBegin")
                },
                ensure_ascii=False,
            ),
        )

    print("\n다 됐습니다.")
    print(f"  → {out} 의 내용을 전달해 주세요 (한 줄짜리 JSON).")
    print("  → 이 파일은 git 에서 제외돼 있습니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
