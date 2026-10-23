-- Agent 消息附件：只存元数据与很小的缩略图，不存参考素材原始字节。
ALTER TABLE canvas_agent_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::JSONB;
