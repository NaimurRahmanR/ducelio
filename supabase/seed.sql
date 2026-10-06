-- LOCAL DEMO ONLY: fictional accounts with no Auth mapping, passwords or login ability.
insert into public.app_users(id,display_name,is_demo) values ('10000000-0000-4000-8000-000000000001','Alex Morgan',true),
('10000000-0000-4000-8000-000000000002','Jamie Carter',true),
('10000000-0000-4000-8000-000000000003','Jordan Lee',true);
insert into public.role_grants values ('10000000-0000-4000-8000-000000000001','STUDENT'),
('10000000-0000-4000-8000-000000000002','COUNSELLOR'),
('10000000-0000-4000-8000-000000000003','STUDENT');
insert into public.student_profiles(user_id,student_number) values ('10000000-0000-4000-8000-000000000001','DUC-DEMO-001'),
('10000000-0000-4000-8000-000000000003','DUC-DEMO-002');
insert into public.staff_profiles values ('10000000-0000-4000-8000-000000000002','Learner success counsellor');
insert into public.programmes values ('20000000-0000-4000-8000-000000000001','cc-demo','ISC2 Certified in Cybersecurity (CC)','ISC2','Certified in Cybersecurity',true);
insert into public.programme_versions(id,programme_id,label,is_demo) values ('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','2026 DEMO — not an official blueprint',true);
insert into public.modules(id,programme_version_id,title,position) values ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Security principles — DEMO',1);
insert into public.lessons(id,module_id,programme_version_id,title,position) values ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Access Control Fundamentals — DEMO',1);
insert into public.lesson_objectives(lesson_id,programme_version_id,description,position) values ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Explain authentication',1),
('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Explain authorisation',2),
('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Explain least privilege',3),
('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Explain role-based access control',4),
('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','Explain multi-factor authentication',5);
update public.programme_versions set status='PUBLISHED';
insert into public.cohorts values ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','September 2026 — DEMO','2026-09-01');
insert into public.enrolments(student_id,cohort_id,programme_version_id) values ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
insert into public.counsellor_assignments(student_id,counsellor_id) values ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
insert into public.student_support_profiles(student_id,study_goal,weekly_hours) values ('10000000-0000-4000-8000-000000000001','Build a consistent evening study routine.',6);
insert into public.study_plans values ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','September study plan — DEMO','ACTIVE');
insert into public.study_plan_items(plan_id,student_id,title,due_on,created_by) values ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Prepare for your next class','2026-09-08','10000000-0000-4000-8000-000000000002');
insert into public.support_events(id,student_id,kind,source_reference,deduplication_key) values ('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','MILESTONE','demo-milestone','demo:student1:milestone1');
insert into public.support_followups(student_id,event_id,title,due_on,created_by) values ('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','Review your weekly study routine','2026-09-10','10000000-0000-4000-8000-000000000002');
insert into public.counsellor_interactions(student_id,counsellor_id,summary) values ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Fictional private interaction used only to verify permission boundaries.');
