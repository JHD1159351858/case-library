/**
 * 零依赖 PostgreSQL 线协议客户端（仅依赖 Node 内置 net/tls/crypto）
 *
 * 为「不能引入 npm 依赖」的运行环境提供最小可用 PG 访问能力：
 *   - StartupMessage + SCRAM-SHA-256（RFC 5802，含 tls-server-end-point channel binding）
 *   - 隐式 TLS（sslmode=require）
 *   - 扩展查询协议（Parse/Bind/Describe/Execute），参数化查询，$1..$N 占位
 *   - 结果列类型解码：bool/int2/int4/int8/float/text/json/jsonb
 *
 * 非通用驱动：不支持游标、COPY、通知、服务端 prepared statement 复用。
 * 每次 query 一次 Parse/Bind/Execute/Sync 往返，单连接串行化。
 */
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  randomBytes,
  createHmac,
  hash,
  pbkdf2Sync
} from 'node:crypto';

/** 解析 postgresql://user:pass@host:port/db?sslmode=require&channel_binding=require */
export function parsePgConnectionString(rawUrl) {
  const url = new URL(rawUrl);
  const params = new URLSearchParams(url.search);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    sslmode: params.get('sslmode') || 'prefer',
    channelBinding: params.get('channel_binding') || 'prefer'
  };
}

const PG_TYPES = {
  BOOL: 16,
  BYTEA: 17,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  JSON: 114,
  FLOAT4: 700,
  FLOAT8: 701,
  JSONB: 3802
};

class PgError extends Error {
  constructor(fields) {
    super(fields.M || fields.S || 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C;
    this.severity = fields.S;
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.fields = fields;
  }
}

const sha256 = (data) => hash('sha256', data, 'buffer');
const hmacSha256 = (key, data) => createHmac('sha256', key).update(data).digest();
const xorBuffers = (a, b) => {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
};
const b64encode = (buf) => Buffer.from(buf).toString('base64');
const b64decode = (str) => Buffer.from(str, 'base64');

export class PgClient {
  /** @param {string|object} target 连接串或已解析配置 */
  constructor(target) {
    this.config = typeof target === 'string' ? parsePgConnectionString(target) : target;
    this.socket = null;
    this.connected = false;
    this._buf = Buffer.alloc(0);
    this._ready = false;
    /** @type {{resolve:Function,reject:Function,text:string,params:any[]}[]} */
    this._queue = [];
    this._op = null;
    this._opError = null;
    this._auth = null;
    this._scram = null;
    this._connectPromise = null;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    return this._connectPromise;
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const { host, port } = this.config;
      const raw = netConnect({ host, port });
      this.socket = raw;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { raw.destroy(); } catch { /* noop */ }
        reject(err);
      };
      raw.on('error', fail);
      raw.once('connect', () => {
        raw.write(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f])); // SSLRequest
        raw.once('data', (reply) => {
          const flag = String.fromCharCode(reply[0]);
          if (flag === 'S') {
            const tlsSocket = tlsConnect({
              socket: raw,
              servername: host,
              // sslmode=require 仅要求加密；平台内网证书可能非公共 CA，不强制校验链
              rejectUnauthorized: this.config.sslmode === 'verify-full' || this.config.sslmode === 'verify-ca'
            });
            tlsSocket.on('error', fail);
            tlsSocket.once('secureConnect', () => {
              this.socket = tlsSocket;
              this._beginAuth(resolve, fail);
            });
          } else if (flag === 'N') {
            if (this.config.sslmode === 'require' || this.config.sslmode === 'verify-ca' || this.config.sslmode === 'verify-full') {
              fail(new Error('PostgreSQL server refused SSL but sslmode=require'));
              return;
            }
            this._beginAuth(resolve, fail);
          } else {
            fail(new Error(`Unexpected SSL negotiation response: ${flag}`));
          }
        });
      });
    });
  }

  _beginAuth(resolve, fail) {
    this._auth = { resolve, fail };
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', fail);

    let body = Buffer.from([0x00, 0x03, 0x00, 0x00]); // 协议版本 3.0
    const params = [
      ['user', this.config.user],
      ['database', this.config.database],
      ['application_name', 'agent-website'],
      ['client_encoding', 'UTF8']
    ];
    for (const [k, v] of params) {
      body = Buffer.concat([body, Buffer.from(k, 'utf8'), Buffer.from([0]), Buffer.from(String(v), 'utf8'), Buffer.from([0])]);
    }
    body = Buffer.concat([body, Buffer.from([0])]);
    this._writeRaw(Buffer.concat([int32(body.length + 4), body]));
  }

  /* ------------------------------ 消息收发 ------------------------------ */

  _writeRaw(buf) {
    this.socket.write(buf);
  }

  _send(type, payload) {
    const head = Buffer.alloc(5);
    head.writeInt32BE(payload.length + 4, 1);
    head[0] = type.charCodeAt(0);
    this._writeRaw(Buffer.concat([head, payload]));
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    let offset = 0;
    while (true) {
      if (this._buf.length - offset < 5) break;
      const msgType = String.fromCharCode(this._buf[offset]);
      const msgLen = this._buf.readInt32BE(offset + 1);
      if (this._buf.length - offset < 1 + msgLen) break;
      const payload = this._buf.subarray(offset + 5, offset + 1 + msgLen);
      offset += 1 + msgLen;
      try {
        this._onMessage(msgType, payload);
      } catch (err) {
        this._failActive(err);
      }
    }
    this._buf = offset === this._buf.length ? Buffer.alloc(0) : this._buf.subarray(offset);
  }

  _onMessage(type, p) {
    switch (type) {
      case 'R': this._handleAuth(p); break;
      case 'E': {
        const err = new PgError(parseFields(p));
        if (this._auth && !this.connected) this._auth.fail(err);
        else this._opError = err; // 等 ReadyForQuery 后再 reject，保持连接可用
        break;
      }
      case 'T': this._handleRowDescription(p); break;
      case 'D': this._handleDataRow(p); break;
      case 'S': /* ParameterStatus */ break;
      case 'K': /* BackendKeyData */ break;
      case 'N': /* NoticeResponse */ break;
      case 'C': {
        // CommandComplete: "SELECT N" / "INSERT 0 N" / "UPDATE N" / "DELETE N" ...
        if (this._op) {
          const tag = p.toString('utf8').replace(/\0$/, '');
          this._op.command = tag;
          const m = tag.match(/(\d+)\s*$/);
          if (m) this._op.affectedRows = Number(m[1]);
        }
        break;
      }
      case 'Z': {
        this._ready = true;
        this.connected = true;
        if (this._auth) {
          const { resolve } = this._auth;
          this._auth = null;
          resolve();
        }
        if (this._op) {
          const op = this._op;
          this._op = null;
          const err = this._opError;
          this._opError = null;
          if (err) op.reject(err);
          else {
            // SELECT 用实际返回行数；INSERT/UPDATE/DELETE 用 CommandComplete 的影响行数
            const isSelect = /^SELECT/i.test(op.command || '');
            const rowCount = isSelect ? op.rows.length : (op.affectedRows ?? op.rows.length);
            op.resolve({ rows: op.rows, rowCount, command: op.command, affectedRows: op.affectedRows ?? null });
          }
        } else {
          this._opError = null;
        }
        const next = this._queue.shift();
        if (next) this._dispatch(next);
        break;
      }
      default: break;
    }
  }

  /* ------------------------------ SCRAM 认证 ------------------------------ */

  _handleAuth(p) {
    const code = p.readInt32BE(0);
    const data = p.subarray(4);
    if (code === 0) return; // AuthenticationOk
    if (code === 3) { // 明文密码
      this._send('p', Buffer.concat([Buffer.from(this.config.password, 'utf8'), Buffer.from([0])]));
      return;
    }
    if (code === 10) { // SASL
      const mechanisms = [];
      let i = 0;
      while (i < data.length) {
        const end = data.indexOf(0, i);
        if (end < 0) break;
        mechanisms.push(data.toString('utf8', i, end));
        i = end + 1;
      }
      // TLS 且能取到对端证书时，优先使用 PLUS 机制（tls-server-end-point），
      // 兼容要求 channel_binding=require 的服务端；否则退回非 PLUS。
      const cert = typeof this.socket.getPeerCertificate === 'function' ? this.socket.getPeerCertificate() : null;
      const usePlus = Boolean(cert && cert.raw) && mechanisms.includes('SCRAM-SHA-256-PLUS');
      const mechanism = usePlus ? 'SCRAM-SHA-256-PLUS' : 'SCRAM-SHA-256';
      if (!mechanisms.includes(mechanism)) {
        this._auth.fail(new Error(`Server does not support ${mechanism}`));
        return;
      }
      this._scramStart(mechanism, usePlus, cert);
      return;
    }
    if (code === 11) { this._scramContinue(data.toString('utf8')); return; }
    if (code === 12) { this._scramFinal(data.toString('utf8')); return; }
    this._auth.fail(new Error(`Unsupported SASL auth code: ${code}`));
  }

  _scramStart(mechanism, usePlus, cert) {
    const nonce = randomBytes(18).toString('base64');
    const clientFirstBare = `n=${this.config.user},r=${nonce}`;
    // GS2 header：PLUS 机制必须为 p=tls-server-end-point,,，非 PLUS 为 n,,
    const gs2Header = usePlus ? 'p=tls-server-end-point,,' : 'n,,';
    // channel-binding 输入（client-final 的 c=）= GS2 header
    // 对 PLUS，GS2 header 即 channel binding 数据（含 tls-server-end-point 证书哈希由服务端校验机制名隐含）
    this._scram = { nonce, clientFirstBare, usePlus, cert, gs2Header };
    const message = gs2Header + clientFirstBare;
    let body = cstring(mechanism);
    body = Buffer.concat([body, int32(Buffer.byteLength(message)), Buffer.from(message, 'utf8')]);
    this._send('p', body);
  }

  _scramContinue(serverFirstMessage) {
    const attrs = parseSaslAttrs(serverFirstMessage);
    const fullNonce = attrs.r;
    const salt = b64decode(attrs.s);
    const iterations = Number.parseInt(attrs.i, 10);
    if (!fullNonce.startsWith(this._scram.nonce)) {
      this._auth.fail(new Error('SCRAM nonce mismatch'));
      return;
    }
    const serverFirst = `r=${fullNonce},s=${attrs.s},i=${attrs.i}`;

    // RFC 5802 §6/§8：client-final 的 channel-binding 输入 =
    //   GS2-header(channel-binding flag + authzid) || channel-binding data
    // 非 PLUS："n,,"（无通道数据）
    // tls-server-end-point："p=tls-server-end-point,," || hash(服务端证书 DER)
    let cbData = Buffer.from(this._scram.gs2Header, 'utf8');
    if (this._scram.usePlus && this._scram.cert?.raw) {
      cbData = Buffer.concat([cbData, sha256(this._scram.cert.raw)]);
    }
    const clientFinalWithoutProof = `c=${b64encode(cbData)},r=${fullNonce}`;
    const authMessage = `${this._scram.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;

    const saltedPassword = pbkdf2Sync(this.config.password, salt, iterations, 32, 'sha256');
    const clientKey = hmacSha256(saltedPassword, 'Client Key');
    const storedKey = sha256(clientKey);
    const clientSignature = hmacSha256(storedKey, authMessage);
    const clientProof = xorBuffers(clientKey, clientSignature);
    const serverKey = hmacSha256(saltedPassword, 'Server Key');
    this._scram.serverSignature = b64encode(hmacSha256(serverKey, authMessage));

    const finalMessage = `${clientFinalWithoutProof},p=${b64encode(clientProof)}`;
    // SASLResponse：直接放 client-final-message，无结尾 null（只有明文 PasswordMessage 才是 cstring）
    this._send('p', Buffer.from(finalMessage, 'utf8'));
  }

  _scramFinal(serverFinalMessage) {
    const attrs = parseSaslAttrs(serverFinalMessage);
    if (!attrs.v || attrs.v !== this._scram.serverSignature) {
      this._auth.fail(new Error('SCRAM server signature verification failed'));
    }
    // 认证成功以随后的 ReadyForQuery(Z) 为准
  }

  /* ------------------------------ 查询 ------------------------------ */

  /**
   * 参数化查询
   * @param {string} text SQL，$1..$N 占位
   * @param {Array<string|number|boolean|null|object>} params 对象自动 JSON.stringify
   * @returns {Promise<{rows:Array<Record<string,any>>,rowCount:number,command?:string}>}
   */
  query(text, params = []) {
    return this.connect().then(() => new Promise((resolve, reject) => {
      const item = { resolve, reject, text, params };
      if (this._ready && this._queue.length === 0 && !this._op) {
        this._dispatch(item);
      } else {
        this._queue.push(item);
      }
    }));
  }

  _dispatch(item) {
    this._ready = false;
    this._op = { resolve: item.resolve, reject: item.reject, rows: [], fields: [], command: '', affectedRows: null };
    // Parse（未命名语句；参数 OID 留 0 由服务端推断）
    let parseBody = cstring('');
    parseBody = Buffer.concat([parseBody, cstring(item.text), int16(item.params.length)]);
    for (let i = 0; i < item.params.length; i++) parseBody = Buffer.concat([parseBody, int32(0)]);
    this._send('P', parseBody);
    // Bind（未命名 portal；参数与结果均用文本格式）
    let bindBody = Buffer.concat([cstring(''), cstring('')]);
    bindBody = Buffer.concat([bindBody, int16(0)]); // 参数格式码数量=0（默认全部文本）
    bindBody = Buffer.concat([bindBody, int16(item.params.length)]);
    for (const value of item.params) {
      const text = encodeParam(value);
      if (text === null) bindBody = Buffer.concat([bindBody, int32(-1)]);
      else bindBody = Buffer.concat([bindBody, int32(Buffer.byteLength(text)), Buffer.from(text, 'utf8')]);
    }
    bindBody = Buffer.concat([bindBody, int16(0)]); // 结果格式码数量=0（全部文本）
    this._send('B', bindBody);
    // Describe portal（拿列描述）
    this._send('D', Buffer.concat([Buffer.from('P', 'utf8'), Buffer.from([0])]));
    // Execute（portal='', maxRows=0 返回全部）
    this._send('E', Buffer.concat([Buffer.from([0]), int32(0)]));
    // Sync
    this._send('S', Buffer.alloc(0));
  }

  _failActive(err) {
    if (this._op) {
      const op = this._op;
      this._op = null;
      op.reject(err);
    }
    const pending = this._queue.splice(0);
    for (const w of pending) w.reject(err);
    try { this._send('S', Buffer.alloc(0)); } catch { /* noop */ }
  }

  _handleRowDescription(p) {
    const fields = [];
    let offset = 0;
    const count = p.readInt16BE(offset); offset += 2;
    for (let i = 0; i < count; i++) {
      const nameEnd = p.indexOf(0, offset);
      const name = p.toString('utf8', offset, nameEnd);
      offset = nameEnd + 1 + 6; // tableOID(4)+colIndex(2)
      const typeOid = p.readInt32BE(offset); offset += 4 + 6; // typeOid + typeLen(2)+typeMod(4)
      const format = p.readInt16BE(offset); offset += 2;
      fields.push({ name, typeOid, format });
    }
    if (this._op) this._op.fields = fields;
  }

  _handleDataRow(p) {
    if (!this._op) return;
    let offset = 0;
    const colCount = p.readInt16BE(offset); offset += 2;
    const row = {};
    for (let i = 0; i < colCount; i++) {
      const len = p.readInt32BE(offset); offset += 4;
      const field = this._op.fields[i] || { name: `col${i}`, typeOid: PG_TYPES.TEXT, format: 0 };
      if (len === -1) {
        row[field.name] = null;
        continue;
      }
      const raw = p.subarray(offset, offset + len);
      offset += len;
      row[field.name] = decodeValue(raw, field.typeOid, field.format);
    }
    this._op.rows.push(row);
  }

  end() {
    return new Promise((resolve) => {
      if (!this.socket) return resolve();
      try { this._send('X', Buffer.alloc(0)); } catch { /* noop */ }
      const timer = setTimeout(() => {
        try { this.socket.destroy(); } catch { /* noop */ }
        resolve();
      }, 500);
      timer.unref?.();
      this.socket.end(() => {
        clearTimeout(timer);
        this.connected = false;
        resolve();
      });
    });
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

function cstring(str) {
  return Buffer.concat([Buffer.from(String(str), 'utf8'), Buffer.from([0])]);
}
function int16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
function int32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function encodeParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return encodePgArray(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 编码为 PostgreSQL 数组字面量 {v1,v2,...}（元素做引号与转义处理） */
function encodePgArray(arr) {
  const parts = arr.map((item) => {
    if (item === null || item === undefined) return 'NULL';
    const s = String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return /[",\\\s{}]/.test(s) ? `"${s}"` : s;
  });
  return `{${parts.join(',')}}`;
}

function decodeValue(raw, typeOid, format) {
  if (format === 1) return decodeBinary(raw, typeOid);
  const text = raw.toString('utf8');
  switch (typeOid) {
    case PG_TYPES.BOOL: return text === 't' || text === 'true' || text === '1';
    case PG_TYPES.INT2:
    case PG_TYPES.INT4:
    case PG_TYPES.INT8: return Number(text);
    case PG_TYPES.FLOAT4:
    case PG_TYPES.FLOAT8: return Number(text);
    case PG_TYPES.JSON:
    case PG_TYPES.JSONB: return JSON.parse(text);
    default: return text;
  }
}

function decodeBinary(raw, typeOid) {
  switch (typeOid) {
    case PG_TYPES.INT2: return raw.readInt16BE(0);
    case PG_TYPES.INT4: return raw.readInt32BE(0);
    case PG_TYPES.INT8: return Number(raw.readBigInt64BE(0));
    case PG_TYPES.FLOAT4: return raw.readFloatBE(0);
    case PG_TYPES.FLOAT8: return raw.readDoubleBE(0);
    case PG_TYPES.BOOL: return raw[0] === 1;
    default: return raw;
  }
}

function parseFields(p) {
  const fields = {};
  let offset = 0;
  while (offset < p.length) {
    const fieldType = String.fromCharCode(p[offset]);
    offset += 1;
    if (fieldType === '\0') break;
    const end = p.indexOf(0, offset);
    if (end < 0) break;
    fields[fieldType] = p.toString('utf8', offset, end);
    offset = end + 1;
  }
  return fields;
}

function parseSaslAttrs(message) {
  const out = {};
  for (const part of message.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
