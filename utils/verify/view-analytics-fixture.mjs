/** 浏览器联调专用：独立临时数据库、案例与会话，绝不写入当前项目数据。 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashToken, startPreviewServer } from '../../project/backend/server.mjs';

const directory = mkdtempSync(join(tmpdir(), 'agent-view-browser-'));
const output = resolve('utils/verify/shots/view-analytics');
mkdirSync(output, { recursive: true });
const base = 'http://localhost:2003';
const site = startPreviewServer({
  port: 2003, host: '127.0.0.1', appPublicUrl: base, ssoCenterUrl: '',
  ssoSharedSecret: '', adminRoles: ['admin'], adminSsoUids: [],
  dbPath: join(directory, 'fixture.db'), uploadsDir: join(directory, 'uploads')
});
const timestamp = Date.now();
const sessions = {};
for (const [role, displayName] of [['admin', '联调管理员（测试）'], ['student', '联调学生（测试）']]) {
  const user = site.db.upsertUserFromIdentity({
    ssoUid: `browser-test-${role}`, name: role, displayName, role, roles: [role],
    openid: '', fid: '', orgName: '独立浏览器测试环境'
  }, role === 'admin', timestamp);
  const token = randomBytes(32).toString('base64url');
  site.db.createSession({ userId: user.id, tokenHash: hashToken(token),
    createdAt: timestamp, expiresAt: timestamp + 60 * 60 * 1000 });
  sessions[role] = token;
}
site.db.insertAgent({
  id: 'browser-view-test', name: '浏览统计联调案例（测试）', summary: '仅用于验证浏览计数，不是正式案例。',
  tags: '联调测试', status: 'active', dataJson: '{}', discipline: '工学', major: '计算机科学与技术',
  courseName: '浏览记录联调', agentUrl: '', schoolName: '测试学校', coverImage: '',
  painPoint: '验证重复访问只增加次数，登录账号去重。', usageGuide: '打开详情、关闭后再次打开，然后在管理端查看浏览明细。',
  createdBy: null, createdAt: timestamp, updatedAt: timestamp
});
// 只含本进程创建的临时会话，用于浏览器切换测试身份；不是生产凭据。
writeFileSync(join(output, 'fixture.json'), JSON.stringify({ base, directory, sessions }, null, 2));
process.on('SIGTERM', () => {
  site.server.closeAllConnections?.();
  site.server.close(() => { site.db.close(); process.exit(0); });
});
