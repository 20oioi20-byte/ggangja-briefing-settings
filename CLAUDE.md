# 깡자동 브리핑 설정 (ggangja-briefing-settings)

## 저장소
- GitHub: https://github.com/20oioi20-byte/ggangja-briefing-settings (branch: main)
- 구성: `index.html` (프론트엔드), `supabase/functions/*` (daily-briefing, keyword-suggest, saju-briefing, youtube-briefing 엣지 함수), `fonts/`

## 작업 방침 (사용자 승인됨)
- 사용자가 새 기능 추가나 현재 오류 개선을 요청하면, 작업 완료 후 **자동으로 git commit + push까지 진행**한다. 매번 push 여부를 다시 묻지 않는다.
- 단, 사용자가 명시적으로 요청하지 않은 기존 UI/기능/설정 값은 **절대 임의로 변경하지 않는다**. 요청 범위 밖의 리팩터링·정리·디자인 변경은 하지 않는다.
- 커밋 메시지는 실제 변경 내용을 반영해 간결하게 작성한다.
- `git push --force`, `git reset --hard` 등 파괴적/기존 이력을 훼손하는 작업은 이 자동 승인 범위에 포함되지 않으며, 필요 시 사용자에게 별도로 확인받는다.
