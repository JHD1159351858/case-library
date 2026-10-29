-- PostgreSQL 持久化结构（生产环境）
-- 语义与 schema.sql(SQLite) 严格一致，由 pg-storage.mjs 启动时幂等执行。
-- 差异：SQLite 用 INTEGER 自增/TEXT 主键；PG 用 BIGINT IDENTITY；tags/data_json 用 JSONB 但以文本语义读写。

-- 1. 用户
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sso_uid       TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    display_name  TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT '',
    roles_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
    openid        TEXT NOT NULL DEFAULT '',
    fid           TEXT NOT NULL DEFAULT '',
    org_name      TEXT NOT NULL DEFAULT '',
    is_admin      SMALLINT NOT NULL DEFAULT 0,
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    last_login_at BIGINT
);

-- 2. 会话
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

-- 3. 智能体案例（id 为业务字符串主键，与 SQLite 版一致）
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
    created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_updated_at ON agents (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_discipline ON agents (discipline);
CREATE INDEX IF NOT EXISTS idx_agents_school     ON agents (school_name);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions (expires_at);

-- 4. 浏览记录：复合主键（案例 + 访客键）
CREATE TABLE IF NOT EXISTS agent_views (
    agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    visitor_key     TEXT NOT NULL,
    user_id         BIGINT REFERENCES users(id) ON DELETE CASCADE,
    view_count      BIGINT NOT NULL DEFAULT 1 CHECK (view_count >= 1),
    first_viewed_at BIGINT NOT NULL,
    last_viewed_at  BIGINT NOT NULL,
    PRIMARY KEY (agent_id, visitor_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_views_recent ON agent_views (agent_id, last_viewed_at DESC, visitor_key ASC);

-- 5. 卡片特效配置（单行 id=1）
CREATE TABLE IF NOT EXISTS card_effect_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    data_json  TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);

-- 6. 手动热门展示位（固定三个位置，单行原子覆盖）
CREATE TABLE IF NOT EXISTS featured_agent_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    data_json  TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);
