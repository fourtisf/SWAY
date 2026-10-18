-- Task catalogue (definitions mirror packages/shared/src/tasks.ts). Rows let ops disable a task.
INSERT INTO "Task" ("id", "title", "pts", "group", "active") VALUES
  ('follow', 'Follow @swaydotfam on X', 1000, 'Join checklist', true),
  ('repost', 'Repost the launch post', 1000, 'Join checklist', true),
  ('tg', 'Join the Telegram', 500, 'Join checklist', true),
  ('card', 'Share your Sway card on X', 2000, 'Join checklist', true),
  ('daily', 'Post with #SwayDaily today', 750, 'Daily', true),
  ('buykey', 'Hold a key you didn’t mint', 1500, 'Daily', true)
ON CONFLICT ("id") DO NOTHING;
