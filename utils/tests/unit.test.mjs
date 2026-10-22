/**
 * 单元测试：SSO 契约与管理员判定（node --test，零依赖）
 *
 * 覆盖：
 *   - resolveReturnTo：站内相对路径、白名单绝对 URL、非白名单拒绝、协议限制
 *   - buildSsoStartUrl / buildSsoLogoutUrl：认证中心地址拼接
 *   - verifySsoTicket：成功 / 各失败码映射（用注入的 fetch 模拟认证中心）
 *   - normalizeIdentity：权威契约字段与宽松字段解析、uid 缺失处理
 *   - computeIsAdmin：role 命中、roles 数组命中、ADMIN_SSO_UIDS 兜底、大小写
 *   - 字段链路：表单字段 → 归一 → 列表 / 详情响应全覆盖（前台展示不丢字段）
 *   - 封面上传：multipart 解析、图片魔数识别（非图片内容拒绝）
 *   - 数据库层：用户 upsert、会话建立/过期清理、智能体写入与检索
 *
 * 运行：node --test "utils/tests/*.test.mjs"
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  agentDetail,
  agentSummary,
  buildSsoLogoutUrl,
  buildSsoStartUrl,
  computeIsAdmin,
  defaultCallbackUrl,
  extractUploadFile,
  hashToken,
  isAdminIdentity,
  mapVerifyFailure,
  normalizeAgentInput,
  normalizeAgentUrl,
  normalizeIdentity,
  parseEnvConfig,
  resolveReturnTo,
  sniffImageMime,
  splitList,
  verifySsoTicket
} from '../../project/backend/server.mjs';
import { createDatabase } from '../../project/backend/database.mjs';

const APP = 'http://127.0.0.1:2001';
const CENTER = 'https://sso.example.com';

test('splitList：去空白、去重、忽略空值', () => {
  assert.deepEqual(splitList('a, b ,,a'), ['a', 'b']);
  assert.deepEqual(splitList(['x', ' x ', '']), ['x']);
  assert.deepEqual(splitList(undefined), []);
});

test('resolveReturnTo：站内相对路径转绝对 URL', () => {
  const config = { allowedReturnOrigins: [APP], appPublicUrl: APP };
  assert.equal(resolveReturnTo('/api/auth/chaoxing/callback', config), `${APP}/api/auth/chaoxing/callback`);
});

test('resolveReturnTo：协议相对路径 //evil.com 必须拒绝', () => {
  const config = { allowedReturnOrigins: [APP], appPublicUrl: APP };
  assert.equal(resolveReturnTo('//evil.com/x', config), null);
});

test('resolveReturnTo：白名单绝对 URL 通过，非白名单拒绝', () => {
  const config = { allowedReturnOrigins: [APP, 'https://ok.example.com'], appPublicUrl: APP };
  assert.equal(resolveReturnTo(`${APP}/cb`, config), `${APP}/cb`);
  assert.equal(resolveReturnTo('https://ok.example.com/cb?x=1', config), 'https://ok.example.com/cb?x=1');
  assert.equal(resolveReturnTo('https://evil.example.com/cb', config), null);
});

test('resolveReturnTo：非 http(s) 协议拒绝', () => {
  const config = { allowedReturnOrigins: [APP], appPublicUrl: APP };
  assert.equal(resolveReturnTo('javascript:alert(1)', config), null);
  assert.equal(resolveReturnTo('ftp://127.0.0.1/cb', config), null);
});

test('buildSsoStartUrl：生成认证中心授权地址并携带 return_to', () => {
  const url = new URL(buildSsoStartUrl({ ssoCenterUrl: CENTER, returnTo: `${APP}/api/auth/chaoxing/callback` }));
  assert.equal(url.origin, CENTER);
  assert.equal(url.pathname, '/api/auth/chaoxing');
  assert.equal(url.searchParams.get('return_to'), `${APP}/api/auth/chaoxing/callback`);
});

test('buildSsoLogoutUrl：未配置认证中心时回退本站地址', () => {
  assert.equal(buildSsoLogoutUrl({ ssoCenterUrl: '', returnTo: `${APP}/?logout=1` }), `${APP}/?logout=1`);
  const url = new URL(buildSsoLogoutUrl({ ssoCenterUrl: CENTER, returnTo: `${APP}/?logout=1` }));
  assert.equal(url.pathname, '/api/auth/logout');
  assert.equal(url.searchParams.get('return_to'), `${APP}/?logout=1`);
});

test('defaultCallbackUrl：回调地址落在本服务', () => {
  assert.equal(defaultCallbackUrl(APP), `${APP}/api/auth/chaoxing/callback`);
});

test('verifySsoTicket：成功返回身份数据', async () => {
  const payload = { uid: 'u1', name: '张三', roles: [] };
  const fetchImpl = async (url, options) => {
    assert.equal(url, `${CENTER}/api/sso/verify`);
    const body = JSON.parse(options.body);
    assert.equal(body.ticket, 'ticket-abc');
    assert.equal(body.secret, 's3cret');
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await verifySsoTicket({ fetchImpl, ssoCenterUrl: CENTER, secret: 's3cret', ticket: 'ticket-abc' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, payload);
});

test('verifySsoTicket：网络异常返回 status 0 且不抛出', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await verifySsoTicket({ fetchImpl, ssoCenterUrl: CENTER, secret: 's', ticket: 't' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'ECONNREFUSED');
});

test('mapVerifyFailure：状态码到错误码映射', () => {
  assert.equal(mapVerifyFailure({ status: 401 }), 'invalid_secret');
  assert.equal(mapVerifyFailure({ status: 400 }), 'invalid_ticket');
  assert.equal(mapVerifyFailure({ status: 410, data: { error: 'ticket_used' } }), 'ticket_used');
  assert.equal(mapVerifyFailure({ status: 410, data: { error: 'ticket_expired' } }), 'ticket_expired');
  assert.equal(mapVerifyFailure({ status: 0 }), 'verify_failed');
  assert.equal(mapVerifyFailure({ status: 500 }), 'verify_failed');
});

test('normalizeIdentity：认证中心权威契约字段', () => {
  const identity = normalizeIdentity({
    uid: 'sso-1',
    name: 'zhangsan',
    displayName: '张三',
    fid: '1001',
    roles: [{ roleId: 'r1', roleName: 'teacher' }]
  });
  assert.equal(identity.ssoUid, 'sso-1');
  assert.equal(identity.name, 'zhangsan');
  assert.equal(identity.displayName, '张三');
  assert.equal(identity.fid, '1001');
  assert.deepEqual(identity.roles, [{ roleId: 'r1', roleName: 'teacher' }]);
  assert.equal(identity.role, 'teacher');
});

test('normalizeIdentity：宽松字段与 roles 字符串数组', () => {
  const identity = normalizeIdentity({ userId: 42, userName: 'lisi', roles: ['admin', { role_name: 'ops' }] });
  assert.equal(identity.ssoUid, '42');
  assert.equal(identity.name, 'lisi');
  assert.equal(identity.displayName, 'lisi');
  assert.deepEqual(identity.roles, [
    { roleId: '', roleName: 'admin' },
    { roleId: '', roleName: 'ops' }
  ]);
});

test('normalizeIdentity：uid 缺失视为无效身份', () => {
  assert.equal(normalizeIdentity({ name: '无名' }), null);
  assert.equal(normalizeIdentity(null), null);
});

test('computeIsAdmin：role 命中（大小写不敏感）', () => {
  const config = { adminRoles: ['admin'], adminSsoUids: [] };
  assert.equal(computeIsAdmin({ sso_uid: 'u', role: 'Admin', roles_json: '[]' }, config), true);
  assert.equal(computeIsAdmin({ sso_uid: 'u', role: 'student', roles_json: '[]' }, config), false);
});

test('computeIsAdmin：roles 数组内的 roleName / roleId 命中', () => {
  const config = { adminRoles: ['sysadmin'], adminSsoUids: [] };
  const user = { sso_uid: 'u', role: 'student', roles_json: JSON.stringify([{ roleId: 'sysadmin', roleName: '普通' }]) };
  assert.equal(computeIsAdmin(user, config), true);
});

test('computeIsAdmin：ADMIN_SSO_UIDS 兜底命中', () => {
  const config = { adminRoles: ['admin'], adminSsoUids: ['u-999'] };
  assert.equal(computeIsAdmin({ sso_uid: 'u-999', role: '', roles_json: '[]' }, config), true);
  assert.equal(computeIsAdmin({ sso_uid: 'u-1', role: '', roles_json: '[]' }, config), false);
});

test('computeIsAdmin：roles_json 损坏时按 role 判定且不抛错', () => {
  const config = { adminRoles: ['admin'], adminSsoUids: [] };
  assert.equal(computeIsAdmin({ sso_uid: 'u', role: 'admin', roles_json: '{坏数据' }, config), true);
});

test('isAdminIdentity：登录前判定与落库判定一致', () => {
  const config = { adminRoles: ['admin'], adminSsoUids: ['u-2'] };
  assert.equal(isAdminIdentity({ ssoUid: 'u-1', role: 'admin', roles: [] }, config), true);
  assert.equal(isAdminIdentity({ ssoUid: 'u-2', role: '', roles: [] }, config), true);
  assert.equal(isAdminIdentity({ ssoUid: 'u-3', role: 'student', roles: [] }, config), false);
});

test('hashToken：sha256 摘要稳定且不可逆', () => {
  const digest = hashToken('token-value');
  assert.equal(digest, hashToken('token-value'));
  assert.equal(digest.length, 64);
  assert.notEqual(digest, 'token-value');
});

test('parseEnvConfig：默认值与覆盖优先级', () => {
  const config = parseEnvConfig({}, { port: 2001, ssoSharedSecret: 'x', ssoCenterUrl: CENTER });
  assert.equal(config.port, 2001);
  assert.equal(config.appPublicUrl, 'http://127.0.0.1:2001');
  assert.deepEqual(config.adminRoles, ['admin']);
  assert.ok(config.allowedReturnOrigins.includes('http://127.0.0.1:2001'));
  assert.ok(config.uploadsDir.endsWith(join('database', 'uploads')), '上传目录默认落在 database/uploads');
});

/* ---------------- 智能体字段归一 ---------------- */

test('normalizeAgentInput：全字段归一与默认值', () => {
  const parsed = normalizeAgentInput({
    name: '  课程知识问答智能体  ',
    summary: ' 依据课程资料回答 ',
    discipline: '工学',
    major: '计算机科学与技术',
    courseName: '数据结构',
    agentUrl: 'https://example.com/agent',
    schoolName: '示例大学',
    coverImage: '/uploads/1.png',
    painPoint: '答疑效率低',
    usageGuide: '打开链接即可使用',
    status: 'inactive'
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.name, '课程知识问答智能体', '首尾空白必须去除');
  assert.equal(parsed.value.discipline, '工学');
  assert.equal(parsed.value.courseName, '数据结构');
  assert.equal(parsed.value.agentUrl, 'https://example.com/agent');
  assert.equal(parsed.value.status, 'inactive');
});

test('normalizeAgentInput：缺名称 / 名称超长 / 非法链接 / 非法封面 / 非法状态', () => {
  assert.equal(normalizeAgentInput({ summary: '无名称' }).error, 'name_required');
  assert.equal(normalizeAgentInput({ name: 'x'.repeat(121) }).error, 'name_too_long');
  assert.equal(normalizeAgentInput({ name: 'ok', agentUrl: 'javascript:alert(1)' }).error, 'invalid_agent_url');
  assert.equal(normalizeAgentInput({ name: 'ok', coverImage: 'ftp://x/y.png' }).error, 'invalid_cover_image');
  assert.equal(normalizeAgentInput({ name: 'ok', status: 'archived' }).error, 'invalid_status');
  assert.equal(normalizeAgentInput({ name: 'ok', painPoint: 'x'.repeat(2001) }).error, 'painPoint_too_long');
  assert.equal(normalizeAgentInput({ name: 'ok', data: '[1,2]' }).error, 'invalid_data_json');
});

test('normalizeAgentInput：partial 模式未提供字段返回 undefined（保留原值）', () => {
  const parsed = normalizeAgentInput({ summary: '只改简介' }, { partial: true });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.summary, '只改简介');
  assert.equal(parsed.value.name, undefined, '未提供的名称不参与更新');
  assert.equal(normalizeAgentInput({}, { partial: true }).value.name, undefined, '空体更新名称保持原值');
});

test('normalizeAgentUrl：站内相对路径 / http(s) 外链放行，其余拒绝', () => {
  assert.equal(normalizeAgentUrl(''), '');
  assert.equal(normalizeAgentUrl('/agents.html?a=1'), '/agents.html?a=1');
  assert.equal(normalizeAgentUrl('https://ok.example.com/x'), 'https://ok.example.com/x');
  assert.equal(normalizeAgentUrl('http://ok.example.com/x'), 'http://ok.example.com/x');
  assert.equal(normalizeAgentUrl('//evil.com/x'), null, '协议相对路径必须拒绝');
  assert.equal(normalizeAgentUrl('data:text/html,x'), null);
});

test('normalizeAgentUrl：危险协议一律拒绝（前台链接不得成为 XSS 入口）', () => {
  for (const value of ['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:x', 'file:///c:/x', 'mailto:a@b.c']) {
    assert.equal(normalizeAgentUrl(value), null, `${value} 必须被拒绝`);
  }
});

test('normalizeAgentUrl：拒绝不可跳转地址与会被浏览器改写的控制字符 / 反斜杠', () => {
  for (const value of ['https://', 'https://#', 'http:// bad', '/\\evil.example', '/\t/evil.example', 'https://exa\nmple.com', '/agents.html\n']) {
    assert.equal(normalizeAgentUrl(value), null, `${JSON.stringify(value)} 必须被拒绝`);
    assert.equal(normalizeAgentInput({ name: '链接校验', agentUrl: value }).error, 'invalid_agent_url');
  }
  assert.equal(normalizeAgentUrl(' /agents.html?q=1#detail '), '/agents.html?q=1#detail');
  assert.equal(normalizeAgentUrl(' https://example.com/agent?q=1#detail '), 'https://example.com/agent?q=1#detail');
});

/* ---------------- 字段完整性：表单 → 归一 → 接口响应 ---------------- */

/** 管理端表单提交的字段集合（与 admin.js readForm 的 body 保持一致） */
const FORM_PAYLOAD = {
  name: '课程知识问答智能体',
  summary: '一句话简介',
  tags: '问答,课程',
  discipline: '工学',
  major: '计算机科学与技术',
  courseName: '数据结构与算法',
  schoolName: '示例大学',
  agentUrl: 'https://example.com/agent/1',
  coverImage: '/uploads/cover.png',
  painPoint: '痛点描述',
  usageGuide: '使用说明',
  status: 'active',
  data: { 场景: '课程答疑' }
};

/** 接口响应必须覆盖的业务字段（列表 + 详情合集） */
const BUSINESS_FIELDS = [
  'name',
  'summary',
  'tags',
  'status',
  'discipline',
  'major',
  'courseName',
  'schoolName',
  'agentUrl',
  'coverImage',
  'painPoint',
  'usageGuide'
];

test('字段链路：表单提交的每个字段都被后端接收（不得静默丢弃）', () => {
  const parsed = normalizeAgentInput(FORM_PAYLOAD);
  assert.equal(parsed.ok, true);
  for (const key of BUSINESS_FIELDS) {
    assert.equal(parsed.value[key], FORM_PAYLOAD[key], `字段 ${key} 必须被后端接收`);
  }
  assert.deepEqual(JSON.parse(parsed.value.dataJson), FORM_PAYLOAD.data, '扩展字段必须以 JSON 落库');
});

test('字段链路：列表摘要 + 详情返回覆盖全部业务字段（前台渲染不丢字段）', () => {
  const row = {
    id: 'agent_1',
    name: FORM_PAYLOAD.name,
    summary: FORM_PAYLOAD.summary,
    tags: FORM_PAYLOAD.tags,
    status: FORM_PAYLOAD.status,
    data_json: JSON.stringify(FORM_PAYLOAD.data),
    discipline: FORM_PAYLOAD.discipline,
    major: FORM_PAYLOAD.major,
    course_name: FORM_PAYLOAD.courseName,
    agent_url: FORM_PAYLOAD.agentUrl,
    school_name: FORM_PAYLOAD.schoolName,
    cover_image: FORM_PAYLOAD.coverImage,
    pain_point: FORM_PAYLOAD.painPoint,
    usage_guide: FORM_PAYLOAD.usageGuide,
    created_by: 1,
    created_at: 1700000000000,
    updated_at: 1700000000001
  };

  const summary = agentSummary(row);
  for (const key of BUSINESS_FIELDS.filter((item) => item !== 'painPoint' && item !== 'usageGuide')) {
    assert.ok(key in summary, `列表返回必须包含 ${key}（前台卡片 / 链接依赖）`);
  }
  assert.equal(summary.agentUrl, FORM_PAYLOAD.agentUrl, '列表必须下发智能体链接');
  assert.equal(summary.coverImage, FORM_PAYLOAD.coverImage, '列表必须下发封面，否则前台无法回显');

  const detail = agentDetail(row);
  for (const key of BUSINESS_FIELDS) {
    assert.ok(key in detail, `详情返回必须包含 ${key}`);
  }
  assert.deepEqual(detail.data, FORM_PAYLOAD.data, '详情必须解析扩展字段');
  assert.equal(detail.createdAt, row.created_at);
});

/* ---------------- 封面上传：multipart 解析与内容校验 ---------------- */

test('extractUploadFile：解析 multipart 文件字段并原样保留二进制内容', () => {
  const boundary = '----unit-boundary';
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 1, 2, 255, 254])]);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="封面.png"\r\nContent-Type: image/png\r\n\r\n`
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const file = extractUploadFile(body, boundary);
  assert.equal(file.field, 'file');
  assert.equal(file.fileName, '封面.png');
  assert.equal(file.contentType, 'image/png');
  assert.deepEqual(file.data, png, '文件内容不得被截断或改写');

  // 只有普通字段（没有 filename）时视为「未提供文件」
  const noFile = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${boundary}--\r\n`
  );
  assert.equal(extractUploadFile(noFile, boundary), null);
  // boundary 对不上时按解析失败抛出（由调用方转 400）
  assert.throws(() => extractUploadFile(Buffer.from('not-multipart'), boundary));
});

test('sniffImageMime：按文件头识别图片类型，非图片内容拒绝', () => {
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)])), 'image/png');
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6)])), 'image/gif');
  assert.equal(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])), 'image/webp');

  assert.equal(sniffImageMime(Buffer.from('<html><script>alert(1)</script></html>')), '', 'HTML 伪装图片必须识别为非图片');
  assert.equal(sniffImageMime(Buffer.from('<?php echo 1; ?>')), '');
  assert.equal(sniffImageMime(Buffer.alloc(0)), '', '空内容不算图片');
});

test('extractUploadFile：图片含近似 multipart 边界时仍原样保留文件内容', () => {
  const boundary = '----unit-boundary';
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const comment = Buffer.from(`裸--${boundary}内容\r\n--${boundary}inside\r\n--${boundary}--inside`);
  const image = Buffer.concat([
    gif.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b])
  ]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="comment.gif"\r\nContent-Type: image/gif\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  assert.deepEqual(extractUploadFile(body, boundary).data, image, '图片中的近似边界不得被当作文件结束');
});

/* ---------------- 数据库层 ---------------- */

function withDatabase(run) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-site-db-'));
  const db = createDatabase({ databasePath: join(dir, 'test.db') });
  try {
    return run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const identity = {
  ssoUid: 'sso-100',
  name: 'zhangsan',
  displayName: '张三',
  role: 'teacher',
  roles: [{ roleId: 'r1', roleName: 'teacher' }],
  openid: 'open-1',
  fid: '1001',
  orgName: '测试机构'
};

/** 智能体插入记录（补齐全部业务列，方便各用例只覆盖关心的字段） */
function agentRecord(overrides = {}) {
  return {
    id: 'agent_1',
    name: '课程问答智能体',
    summary: '依据课程资料回答提问',
    tags: '问答,课程',
    status: 'active',
    dataJson: '{}',
    discipline: '',
    major: '',
    courseName: '',
    agentUrl: '',
    schoolName: '',
    coverImage: '',
    painPoint: '',
    usageGuide: '',
    createdBy: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

test('数据库：用户 upsert 建档并返回完整行', () => {
  withDatabase((db) => {
    const created = db.upsertUserFromIdentity(identity, false, 1000);
    assert.equal(created.sso_uid, 'sso-100');
    assert.equal(created.display_name, '张三');
    assert.equal(created.is_admin, 0);

    const updated = db.upsertUserFromIdentity({ ...identity, displayName: '张三丰' }, true, 2000);
    assert.equal(updated.id, created.id, '同一 uid 必须复用同一行');
    assert.equal(updated.display_name, '张三丰');
    assert.equal(updated.is_admin, 1);
    assert.equal(db.findUserBySsoUid('sso-100').updated_at, 2000);
  });
});

test('数据库：会话建立、读取与过期清理', () => {
  withDatabase((db) => {
    const user = db.upsertUserFromIdentity(identity, false, 1000);
    const tokenHash = hashToken('token-1');
    db.createSession({ userId: user.id, tokenHash, expiresAt: 5000, createdAt: 1000 });

    const found = db.findSessionUser(tokenHash, 4000);
    assert.equal(found.user.id, user.id);

    assert.equal(db.findSessionUser(tokenHash, 5001), null, '过期会话必须失效');
    assert.equal(db.findSessionUser(hashToken('other'), 4000), null);

    db.createSession({ userId: user.id, tokenHash: hashToken('token-2'), expiresAt: 10, createdAt: 1 });
    db.purgeExpiredSessions(100);
    assert.equal(db.findSessionUser(hashToken('token-2'), 100), null);
  });
});

test('数据库：删除会话后立即失效', () => {
  withDatabase((db) => {
    const user = db.upsertUserFromIdentity(identity, false, 1000);
    const tokenHash = hashToken('token-x');
    db.createSession({ userId: user.id, tokenHash, expiresAt: 99999, createdAt: 1000 });
    assert.ok(db.findSessionUser(tokenHash, 2000));
    db.deleteSession(tokenHash);
    assert.equal(db.findSessionUser(tokenHash, 2000), null);
  });
});

test('数据库：智能体写入、关键词检索与扩展字段解析', () => {
  withDatabase((db) => {
    const user = db.upsertUserFromIdentity(identity, true, 1000);
    db.insertAgent(
      agentRecord({
        id: 'agent_1',
        dataJson: JSON.stringify({ 场景: '课程答疑' }),
        createdBy: user.id,
        discipline: '工学'
      })
    );
    db.insertAgent(
      agentRecord({
        id: 'agent_2',
        name: '作业批改智能体',
        summary: '对主观题作答给出评分建议',
        tags: '批改',
        dataJson: JSON.stringify({ 场景: '作业批改' }),
        updatedAt: 2000
      })
    );
    assert.equal(db.countAgents(), 2);

    assert.equal(db.listAgents({}).total, 2, '空关键词返回全部');
    assert.equal(db.listAgents({ query: '课程' }).total, 1);
    assert.equal(db.listAgents({ query: '批改' }).total, 1, '名称 / 标签均参与检索');
    assert.equal(db.listAgents({ query: '不存在' }).total, 0);

    const listed = db.listAgents({});
    assert.equal(listed.items[0].id, 'agent_2', '按更新时间倒序');
    assert.equal(listed.items[0].pain_point, undefined, '列表列不含长文本字段');

    const found = db.findAgentById('agent_1');
    assert.equal(found.data_json, '{"场景":"课程答疑"}');
    assert.equal(found.discipline, '工学');
    assert.equal(db.findAgentById('missing'), null);
  });
});

test('数据库：学科 / 学校 / 状态筛选与分页', () => {
  withDatabase((db) => {
    db.insertAgent(agentRecord({ id: 'a1', name: '一号', discipline: '工学', schoolName: '甲大学', courseName: '数据结构' }));
    db.insertAgent(agentRecord({ id: 'a2', name: '二号', discipline: '文学', schoolName: '乙大学', updatedAt: 2000 }));
    db.insertAgent(agentRecord({ id: 'a3', name: '三号', discipline: '工学', schoolName: '甲大学', status: 'inactive', updatedAt: 3000 }));

    assert.equal(db.listAgents({ discipline: '工学' }).total, 2);
    assert.equal(db.listAgents({ discipline: '文学' }).total, 1);
    assert.equal(db.listAgents({ school: '甲大学' }).total, 2);
    assert.equal(db.listAgents({ school: '不存在大学' }).total, 0);
    assert.equal(db.listAgents({ status: 'inactive' }).total, 1);
    assert.equal(db.listAgents({ discipline: '工学', status: 'active' }).total, 1, '筛选条件之间是且关系');
    assert.equal(db.listAgents({ query: '数据结构' }).total, 1, '课程名称参与检索');

    const page = db.listAgents({ limit: 2, offset: 0 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3, 'total 与分页无关');
    assert.equal(page.items[0].id, 'a3', '分页仍按更新时间倒序');
    const second = db.listAgents({ limit: 2, offset: 2 });
    assert.equal(second.items.length, 1);
  });
});

test('数据库：更新、删除与引用检查', () => {
  withDatabase((db) => {
    db.insertAgent(agentRecord({ id: 'a1', coverImage: '/uploads/old.png' }));
    assert.equal(db.isCoverInUse('/uploads/old.png'), true);
    assert.equal(db.isCoverInUse('/uploads/missing.png'), false);
    assert.equal(db.isCoverInUse(''), false);

    const row = db.findAgentById('a1');
    const updated = db.updateAgent({
      id: 'a1',
      name: '改名后',
      summary: row.summary,
      tags: row.tags,
      status: 'inactive',
      dataJson: row.data_json,
      discipline: '文学',
      major: row.major,
      courseName: row.course_name,
      agentUrl: row.agent_url,
      schoolName: row.school_name,
      coverImage: '/uploads/new.png',
      painPoint: '新痛点',
      usageGuide: row.usage_guide,
      updatedAt: 5000
    });
    assert.equal(updated.name, '改名后');
    assert.equal(updated.discipline, '文学');
    assert.equal(updated.cover_image, '/uploads/new.png');
    assert.equal(updated.updated_at, 5000);
    assert.equal(db.isCoverInUse('/uploads/old.png'), false, '封面替换后旧文件失去引用');
    assert.equal(db.isCoverInUse('/uploads/new.png'), true);

    assert.equal(db.deleteAgent('a1'), true);
    assert.equal(db.deleteAgent('a1'), false, '重复删除返回 false');
    assert.equal(db.countAgents(), 0);
  });
});

test('数据库：概览统计按学科 / 学校聚合', () => {
  withDatabase((db) => {
    db.insertAgent(agentRecord({ id: 'a1', discipline: '工学', schoolName: '甲大学' }));
    db.insertAgent(agentRecord({ id: 'a2', discipline: '工学', schoolName: '甲大学', updatedAt: 2000 }));
    db.insertAgent(agentRecord({ id: 'a3', discipline: '文学', schoolName: '乙大学', updatedAt: 3000 }));
    db.insertAgent(agentRecord({ id: 'a4', updatedAt: 4000 }));

    const stats = db.agentStats();
    assert.equal(stats.total, 4);
    assert.deepEqual(stats.disciplines[0], { discipline: '工学', total: 2 });
    assert.equal(stats.schools.length, 2, '空学校不计入分布');
  });
});

test('数据库：旧库缺列时启动自动补齐（迁移幂等）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-site-migrate-'));
  const databasePath = join(dir, 'legacy.db');

  // 手工复刻改版前的老表结构（无业务列、无新索引），模拟存量库
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE agents (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      summary    TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'active',
      data_json  TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  legacy.prepare(
    'INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run('legacy_1', '存量智能体', 1, 1);
  legacy.close();

  // 重新打开：迁移应补齐缺失列，且不影响存量数据
  const db = createDatabase({ databasePath });
  try {
    assert.equal(db.countAgents(), 1, '存量数据必须保留');
    db.insertAgent(agentRecord({ id: 'm1', discipline: '工学', painPoint: '痛点', coverImage: '/uploads/x.png' }));
    const row = db.findAgentById('m1');
    assert.equal(row.discipline, '工学');
    assert.equal(row.pain_point, '痛点');
    assert.equal(row.cover_image, '/uploads/x.png');
    assert.equal(db.listAgents({ discipline: '工学' }).total, 1, '补齐的列可正常筛选');
  } finally {
    db.close();
  }

  // 再次打开（迁移幂等，不重复报错）
  const reopened = createDatabase({ databasePath });
  try {
    assert.equal(reopened.countAgents(), 2);
    assert.equal(reopened.findAgentById('m1').discipline, '工学');
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('数据库：LIKE 通配符按字面量处理（% 不作为通配符）', () => {
  withDatabase((db) => {
    db.insertAgent(agentRecord({ id: 'agent_pct', name: '100%命中率智能体', summary: '', tags: '' }));
    assert.equal(db.listAgents({ query: '%' }).total, 1);
    assert.equal(db.listAgents({ query: '100%' }).total, 1);
    assert.equal(db.listAgents({ query: '_' }).total, 0, '下划线不得作为单字符通配符');
  });
});
