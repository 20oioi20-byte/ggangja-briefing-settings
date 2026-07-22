-- 보안 조치: settings/briefing_interests/briefings/saju_members/youtube_channels는
-- 이제 briefing-api Edge Function(service_role, RLS 우회)을 통해서만 접근합니다.
-- RLS를 켜고 anon/authenticated용 정책을 두지 않으면 두 역할의 직접 접근은 전부 차단되고,
-- service_role을 쓰는 기존 Edge Function들(daily-briefing, saju-briefing, saju-annual,
-- youtube-briefing, kakao-send, briefing-api)은 영향을 받지 않습니다.
alter table settings enable row level security;
alter table briefing_interests enable row level security;
alter table briefings enable row level security;
alter table saju_members enable row level security;
alter table youtube_channels enable row level security;
