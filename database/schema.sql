-- ============================================================================
-- agent-official-website · 数据库结构
-- 引擎：SQLite（Node 内置 node:sqlite，零依赖）
-- 文件：database/agent-website.db（运行时自动创建，已加入 .gitignore）
--
-- 维护约定：
--   1. 本文件为唯一结构真理源，后端启动时读取并执行（CREATE TABLE IF NOT EXISTS）
--   2. 新增业务字段优先进入 agents.data_json（可扩展结构），避免频繁改表
--   3. 破坏性变更（删列 / 改名）必须走迁移脚本，不得直接改本文件
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users：超星 SSO 登录后建立的用户档案
--   sso_uid     认证中心返回的 uid（业务主键，唯一）
--   name        认证中心返回的 name（账号名）
--   display_name认证中心返回的 displayName（展示名）
--   role        认证中心返回的 role（若为数组则归一到 roles_json）
--   roles_json  认证中心返回的 roles 原始数组（JSON 文本）
--   openid / fid / org_name  认证中心返回的 openid、fid、orgName
--   is_admin    登录时按 ADMIN_ROLES / ADMIN_SSO_UIDS 计算并落库（响应时实时重算）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  sso_uid       TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT '',
  roles_json    TEXT NOT NULL DEFAULT '[]',
  openid        TEXT NOT NULL DEFAULT '',
  fid           TEXT NOT NULL DEFAULT '',
  org_name      TEXT NOT NULL DEFAULT '',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_login_at INTEGER
) STRICT;

-- ---------------------------------------------------------------------------
-- sessions：本站会话（登录成功后种 Cookie，token 只存 sha256 摘要）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- agents：智能体应用案例（查询平台 + 管理端同一份数据）
--
--   业务字段（2026-09 字段改版后确认，一条记录同时是「智能体」和「案例」）：
--     name / summary            智能体名称（=案例名称）/ 简介（=案例简介）
--     discipline                学科门类
--     major                     具体专业
--     course_name               课程名称
--     agent_url                 智能体链接（=案例链接）
--     school_name               所属学校
--     cover_image               案例封面（/uploads/ 站内路径或 http(s) 外链）
--     pain_point                痛点
--     usage_guide               使用说明
--     tags / status / data_json 兼容保留（标签、启用状态、扩展字段）
--
--   已有库升级：后端启动时对缺失的业务列执行 ALTER TABLE ADD COLUMN 自动补齐
--              （见 project/backend/database.mjs 的 migrateAgentColumns）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  data_json   TEXT NOT NULL DEFAULT '{}',
  discipline  TEXT NOT NULL DEFAULT '',
  major       TEXT NOT NULL DEFAULT '',
  course_name TEXT NOT NULL DEFAULT '',
  agent_url   TEXT NOT NULL DEFAULT '',
  school_name TEXT NOT NULL DEFAULT '',
  cover_image TEXT NOT NULL DEFAULT '',
  pain_point  TEXT NOT NULL DEFAULT '',
  usage_guide TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agents_updated_at ON agents (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_discipline ON agents (discipline);
CREATE INDEX IF NOT EXISTS idx_agents_school ON agents (school_name);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- 成功打开案例详情后的浏览记录：账号 / 匿名浏览器分别去重，访客键只在服务端使用。
CREATE TABLE IF NOT EXISTS agent_views (
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  visitor_key     TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  view_count      INTEGER NOT NULL DEFAULT 1 CHECK (view_count >= 1),
  first_viewed_at INTEGER NOT NULL,
  last_viewed_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, visitor_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_views_recent ON agent_views (agent_id, last_viewed_at DESC, visitor_key ASC);

-- 全站热门卡片效果配置：仅管理员发布，未保存时不插入默认行。
CREATE TABLE IF NOT EXISTS card_effect_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- 手动热门展示位：固定三个位置，整组 JSON 原子覆盖；未保存时不插入默认行。
CREATE TABLE IF NOT EXISTS featured_agent_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- 上传图片字节与数据库共同持久化，不依赖实例临时目录。
CREATE TABLE IF NOT EXISTS uploaded_images (
  file_name    TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;
