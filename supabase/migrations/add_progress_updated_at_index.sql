-- 支持 getCloudFreshnessSignals 对 user_word_progress.updated_at 的 MAX 查询
-- 该查询用于第四个新鲜度信号：检测另一台设备是否已完成完整上传（含进度表写入）
CREATE INDEX IF NOT EXISTS idx_user_word_progress_user_updated
  ON public.user_word_progress(user_id, updated_at DESC);
