// ================================================================
// Code.gs — Google Apps Script Web App Backend  v4 (Secure)
// ระบบวิเคราะห์ผู้เรียนรายบุคคล
// วิทยาลัยเทคนิคประจวบคีรีขันธ์  แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล
//
// สิ่งที่เปลี่ยนจาก v3:
//   1) doGet ไม่คืนข้อมูลอีกต่อไป  — อ่านข้อมูลได้เฉพาะผู้ที่ login (token ฝั่งเซิร์ฟเวอร์)
//   2) รหัสผ่านเก็บเป็น hash ใน Script Properties (ไม่อยู่ในโค้ด/หน้าเว็บ)
//   3) AI วิเคราะห์ทำที่หลังบ้าน (API key อยู่ใน Script Properties) ผ่าน trigger ทุก 5 นาที
//      และไม่ส่งชื่อ-นามสกุลนักเรียนไปยัง AI
//   4) LockService กันข้อมูลชนกัน + ส่งข้อมูลครั้งเดียวต่อคน (learner+phq+adhd)
//   5) PHQ-A ข้อ 9 > 0 → แถบสีใน Sheet + แจ้งเตือนบนแดชบอร์ด (มีปุ่ม "รับทราบ" บันทึกเวลา) — ไม่ส่งอีเมล/LINE
//   6) เซิร์ฟเวอร์คำนวณคะแนน PHQ/ADHD/_risk/กลุ่มผู้เรียนเอง (ไม่เชื่อค่าจากเบราว์เซอร์)
//   7) เก็บ _ts / เบอร์โทร / รหัสนักเรียน เป็น "ข้อความ" (กัน Sheets แปลงเป็นวันที่/ตัดเลข 0)
//
// วิธีติดตั้ง (ทำตามลำดับ):
//   1. วางโค้ดนี้ใน Apps Script (Extensions → Apps Script) แทนของเดิม แล้ว Save
//   2. รัน setupSecurity()  → ตั้งผู้ใช้/รหัสผ่านแอดมิน และ API key (ไม่บังคับ) ครั้งเดียว
//   3. รัน diagnoseSheets() → ดูผลตรวจโครงสร้างชีตเดิมที่ View → Logs / Execution log
//   4. รัน repairSheets()   → ซ่อมข้อมูลเดิม (วันที่, เบอร์โทร, คะแนนที่เป็น NaN)
//   5. Deploy → Manage deployments → Edit → New version  (Execute as: Me | Anyone)
//      *ต้อง "New version" ทุกครั้งที่แก้โค้ด URL เดิมจึงจะใช้โค้ดใหม่*
//
// ลืมรหัสผ่าน / ถูกล็อก:
//   • resetAdminPassword() → ตั้งรหัสผ่านใหม่ (และแสดงชื่อผู้ใช้เดิม) — รันได้เฉพาะเจ้าของสคริปต์
//   • unlockLogin()        → ปลดล็อกหลังใส่รหัสผิดเกิน 5 ครั้ง (ไม่ต้องรอ 10 นาที)
//   • เปลี่ยนรหัสผ่านปกติ: กดปุ่ม 🔑 บนแดชบอร์ด
// ================================================================

const SH = { learner: 'learner_data', phq: 'phq_data', adhd: 'adhd_data' };
const TZ = 'Asia/Bangkok';

const AI_MODEL        = 'claude-sonnet-5-5';   // เปลี่ยนได้ที่นี่ที่เดียว
const AI_MAX_PER_RUN  = 6;                     // วิเคราะห์ไม่เกินกี่คนต่อรอบ trigger
const AI_MAX_RETRY    = 3;
const TOKEN_TTL_SEC   = 21600;                 // 6 ชม. (เพดานของ CacheService)
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_SEC  = 600;
const SUBMIT_PER_MIN  = 150;                   // เบรกกันถูกยิงรัว ๆ (ทั้งห้องส่งพร้อมกันยังพอ)

// เกณฑ์คัดกรอง ADHD (อิง DSM-5 / SNAP-IV 18 ข้อ): นับข้อที่ตอบ ≥2 ("บ่อยครั้ง"/"บ่อยมาก")
// ≥ ADHD_CUT จาก 9 ข้อของด้านใดด้านหนึ่ง = มีแนวโน้ม  (DSM-5: 6 ข้อ อายุ ≤16 ปี | 5 ข้อ อายุ ≥17 ปี)
const ADHD_CUT = 6, ADHD_WATCH = 4;

const TEXT_COLS = ['_id', '_ts', 'student_no', 'phone', 'parent_phone', 'alert_ack'];
const LONG_COLS = { student_note: 1000, special_skills: 300, social_platforms: 300, programs_used: 300, digital_biz_exp: 300 };

const PHQ_ITEMS = [
  'รู้สึกหดหู่ เศร้า หรือสิ้นหวัง',
  'ไม่สนใจหรือไม่มีความสุขกับสิ่งที่เคยสนุก',
  'นอนหลับยาก หลับไม่หลับ หรือนอนมากเกินไป',
  'รู้สึกอ่อนเพลีย หรือไม่มีแรง',
  'รับประทานอาหารไม่อยาก หรือกินมากเกินไป',
  'รู้สึกแย่กับตัวเอง หรือรู้สึกว่าตัวเองเป็นภาระ',
  'มีปัญหาในการมีสมาธิ',
  'พูดหรือเคลื่อนไหวช้า หรือกระวนกระวาย อยู่ไม่นิ่ง',
  'มีความคิดทำร้ายตัวเองหรืออยากตาย'
];

const HDR_LEARNER = [
  '_id','_ts','fullname','level','classroom','student_no',
  'gender','gpax','phone','parent_phone',
  'computer_skill_level','typing_speed','english_tech',
  'problem_solving','learning_style','challenge_attitude','planning_habit','multitasking',
  'submission_habit','absence','help_seeking','part_time','sleep_hours',
  'has_computer','home_internet','smartphone_os','uses_ai',
  'family_support','living_status','career_goal','stress_level',
  'special_skills','social_platforms','student_note',
  'digital_biz_exp','programs_used',
  '_risk','learning_group'
];
const HDR_PHQ = [
  '_id','_ts','fullname','level','classroom','gender',
  'phq_total','phq_severity',
  'phq_q1','phq_q2','phq_q3','phq_q4','phq_q5',
  'phq_q6','phq_q7','phq_q8','phq_q9',
  'q9_alert','alert_ack',
  'ai_analysis'
];
const HDR_ADHD = [
  '_id','_ts','fullname','level','classroom','gender',
  'adhd_total','adhd_inatt','adhd_hyper','adhd_severity','adhd_inatt_cnt','adhd_hyper_cnt',
  'adhd_q1','adhd_q2','adhd_q3','adhd_q4','adhd_q5','adhd_q6',
  'adhd_q7','adhd_q8','adhd_q9','adhd_q10','adhd_q11','adhd_q12',
  'adhd_q13','adhd_q14','adhd_q15','adhd_q16','adhd_q17','adhd_q18',
  'ai_analysis'
];
const HDR = { learner: HDR_LEARNER, phq: HDR_PHQ, adhd: HDR_ADHD };

// ================================================================
// Web App entry points
// ================================================================
function doGet(e) {
  // ไม่คืนข้อมูลใด ๆ — ใช้เช็คว่าบริการทำงานอยู่เท่านั้น
  return jsonOut({ ok: true, service: 'learner-analysis', version: 'v4' });
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    if (raw.length > 200000) return jsonOut({ ok: false, error: 'too_large' });
    const req = JSON.parse(raw);
    switch (req.action) {
      case 'submit': return jsonOut(handleSubmit(req));
      case 'login':  return jsonOut(handleLogin(req));
      case 'read':   return jsonOut(handleRead(req));
      case 'logout': return jsonOut(handleLogout(req));
      case 'ack':    return jsonOut(handleAck(req));
      case 'changePassword': return jsonOut(handleChangePassword(req));
      default:       return jsonOut({ ok: false, error: 'bad_action' });
    }
  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return jsonOut({ ok: false, error: 'server_error' });
  }
}

// ================================================================
// Auth
// ================================================================
function handleLogin(req) {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('loginfail') || 0);
  if (fails >= MAX_LOGIN_FAILS) return { ok: false, error: 'locked' };

  const user = String(req.username || '').trim();
  const pass = String(req.password || '');
  const savedUser = props.getProperty('ADMIN_USER') || '';
  const savedHash = props.getProperty('ADMIN_HASH') || '';
  const salt      = props.getProperty('ADMIN_SALT') || '';

  const okUser = savedUser !== '' && constEq(user, savedUser);
  const okPass = savedHash !== '' && constEq(hashPass(pass, salt), savedHash);
  if (!(okUser && okPass)) {
    cache.put('loginfail', String(fails + 1), LOGIN_LOCK_SEC);
    Utilities.sleep(700);
    return { ok: false, error: 'invalid' };
  }
  cache.remove('loginfail');
  return { ok: true, token: issueToken(), expiresIn: TOKEN_TTL_SEC };
}

function handleLogout(req) {
  const t = String(req.token || '');
  if (t) CacheService.getScriptCache().remove(tokKey(t));
  return { ok: true };
}

// token ผูกกับ "epoch" — เปลี่ยน/รีเซ็ตรหัสผ่านแล้ว epoch เพิ่ม ทำให้ทุกเซสชันเก่าใช้ไม่ได้ทันที
function epoch() { return PropertiesService.getScriptProperties().getProperty('TOKEN_EPOCH') || '0'; }
function bumpEpoch() {
  const props = PropertiesService.getScriptProperties();
  const n = String(Number(props.getProperty('TOKEN_EPOCH') || '0') + 1);
  props.setProperty('TOKEN_EPOCH', n);
  return n;
}
function tokKey(token) { return 'tok:' + epoch() + ':' + token; }
function issueToken() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(tokKey(token), '1', TOKEN_TTL_SEC);
  return token;
}
function checkToken(token) {
  const t = String(token || '');
  if (t.length < 40) return false;
  return CacheService.getScriptCache().get(tokKey(t)) === '1';
}
function isStrongPass(p) {
  p = String(p);
  return p.length >= 10 && !/admin1234/i.test(p) && new Set(p.split('')).size >= 4;
}

function handleChangePassword(req) {
  if (!checkToken(req.token)) return { ok: false, error: 'unauthorized' };
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('loginfail') || 0);
  if (fails >= MAX_LOGIN_FAILS) return { ok: false, error: 'locked' };
  const props = PropertiesService.getScriptProperties();
  const oldPw = String(req.oldPassword || ''), newPw = String(req.newPassword || '');
  if (!constEq(hashPass(oldPw, props.getProperty('ADMIN_SALT') || ''), props.getProperty('ADMIN_HASH') || '')) {
    cache.put('loginfail', String(fails + 1), LOGIN_LOCK_SEC);
    Utilities.sleep(700);
    return { ok: false, error: 'wrong_old' };
  }
  if (!isStrongPass(newPw) || newPw === oldPw) return { ok: false, error: 'weak' };
  const salt = Utilities.getUuid();
  props.setProperties({ ADMIN_SALT: salt, ADMIN_HASH: hashPass(newPw, salt) });
  bumpEpoch();                                   // ออกจากระบบทุกอุปกรณ์
  return { ok: true, token: issueToken() };      // เครื่องที่เปลี่ยนรหัสยังใช้งานต่อได้
}

// ครูกด "รับทราบ" ที่แดชบอร์ด → บันทึกเวลาลงคอลัมน์ alert_ack ของชีต phq_data
function handleAck(req) {
  if (!checkToken(req.token)) return { ok: false, error: 'unauthorized' };
  const id = String(req.id || '');
  if (!/^[A-Za-z0-9]{5,30}$/.test(id)) return { ok: false, error: 'invalid' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'busy' };
  try {
    const sh = getSheet('phq');
    const headers = readHeaders(sh);
    const row = findRow(sh, headers.indexOf('_id') + 1, id);
    if (row < 0) return { ok: false, error: 'not_found' };
    const cell = sh.getRange(row, headers.indexOf('alert_ack') + 1);
    let ts = cellStr(cell.getValue());
    if (!ts) { ts = nowThai(); cell.setNumberFormat('@'); cell.setValue(ts); }
    sh.getRange(row, 1, 1, headers.length).setBackground('#E5F5EC');
    return { ok: true, ts: ts };
  } finally { lock.releaseLock(); }
}

function handleRead(req) {
  if (!checkToken(req.token)) return { ok: false, error: 'unauthorized' };
  const types = Array.isArray(req.types) && req.types.length ? req.types : ['learner', 'phq', 'adhd'];
  const data = {};
  types.forEach(t => { if (SH[t]) data[t] = readAll(t); });
  return { ok: true, data: data };
}

function hashPass(pass, salt) {
  let h = salt + ':' + pass;
  for (let i = 0; i < 1000; i++) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8);
    h = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
  return h;
}
function constEq(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ================================================================
// Submit (public)  — ส่งครั้งเดียวได้ทั้ง learner + phq + adhd
// ================================================================
function handleSubmit(req) {
  if (!rateOk()) return { ok: false, error: 'busy' };
  const recs = req.records || {};
  if (!recs.learner) return { ok: false, error: 'invalid' };

  let id = String(req.id || '');
  if (!/^[A-Za-z][A-Za-z0-9]{5,24}$/.test(id)) id = 'S' + Utilities.getUuid().replace(/-/g, '').slice(0, 14);

  const learner = buildRecord('learner', recs.learner, id, null);
  if (!learner) return { ok: false, error: 'invalid' };
  const common = { fullname: learner.fullname, level: learner.level, classroom: learner.classroom, gender: learner.gender || '' };
  const phq  = recs.phq  ? buildRecord('phq',  recs.phq,  id, common) : null;
  const adhd = recs.adhd ? buildRecord('adhd', recs.adhd, id, common) : null;
  if (recs.phq && !phq)   return { ok: false, error: 'invalid' };
  if (recs.adhd && !adhd) return { ok: false, error: 'invalid' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
  try {
    upsert('learner', learner);
    if (adhd) upsert('adhd', adhd);
    if (phq) {
      const info = upsert('phq', phq);
      if (phq.q9_alert) handleQ9(info, phq);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, id: id };
}

function rateOk() {
  const c = CacheService.getScriptCache();
  const k = 'rate:' + Math.floor(Date.now() / 60000);
  const n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), 120);
  return n <= SUBMIT_PER_MIN;
}

// ---------- sanitize + คำนวณฝั่งเซิร์ฟเวอร์ ----------
function cleanStr(v, max) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) v = v.map(x => cleanStr(x, 100)).filter(Boolean).join(', ');
  v = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[<>]/g, '').trim();
  if (v.length > max) v = v.slice(0, max);
  if (/^[=+\-@]/.test(v)) v = ' ' + v;          // กัน formula injection ใน Sheets/Excel
  return v;
}

const SERVER_OWNED = {
  _id: 1, _ts: 1, ai_analysis: 1, alert_ack: 1, alert_sent: 1, q9_alert: 1, _risk: 1, learning_group: 1,
  phq_total: 1, phq_severity: 1, adhd_total: 1, adhd_inatt: 1, adhd_hyper: 1, adhd_severity: 1, adhd_inatt_cnt: 1, adhd_hyper_cnt: 1
};

function buildRecord(type, raw, id, common) {
  if (!raw || typeof raw !== 'object') return null;
  const rec = { _id: id };
  HDR[type].forEach(h => {
    if (SERVER_OWNED[h] || /^(phq|adhd)_q\d+$/.test(h)) return;
    if (raw[h] !== undefined) rec[h] = cleanStr(raw[h], LONG_COLS[h] || 200);
  });

  if (type === 'learner') {
    if (!rec.fullname || !rec.level || !rec.classroom) return null;
    rec._risk = calcRisk(rec);
    rec.learning_group = classifyLearner(rec);
    return rec;
  }

  // phq / adhd: ใช้ข้อมูลระบุตัวตนจาก learner เพื่อให้ตรงกันทุกชีต
  if (common) { rec.fullname = common.fullname; rec.level = common.level; rec.classroom = common.classroom; rec.gender = common.gender; }
  if (!rec.fullname) return null;

  const n = type === 'phq' ? 9 : 18;
  const a = [];
  for (let i = 1; i <= n; i++) {
    const v = Number(raw[type + '_q' + i]);
    if (raw[type + '_q' + i] === '' || raw[type + '_q' + i] === null || !Number.isInteger(v) || v < 0 || v > 3) return null;
    a.push(v);
    rec[type + '_q' + i] = v;
  }
  const sum = arr => arr.reduce((x, y) => x + y, 0);
  if (type === 'phq') {
    rec.phq_total = sum(a);
    rec.phq_severity = phqSev(rec.phq_total).key;
    rec.q9_alert = a[8] >= 2 ? 'ด่วน' : (a[8] === 1 ? 'ติดตาม' : '');
  } else {
    rec.adhd_inatt = sum(a.slice(0, 9));
    rec.adhd_hyper = sum(a.slice(9));
    rec.adhd_total = rec.adhd_inatt + rec.adhd_hyper;
    rec.adhd_inatt_cnt = a.slice(0, 9).filter(v => v >= 2).length;
    rec.adhd_hyper_cnt = a.slice(9).filter(v => v >= 2).length;
    rec.adhd_severity = adhdSev(rec.adhd_inatt_cnt, rec.adhd_hyper_cnt).key;
  }
  return rec;
}

function phqSev(s) {
  if (s <= 4)  return { key: 'none', label: 'ปกติ' };
  if (s <= 9)  return { key: 'mild', label: 'น้อย' };
  if (s <= 14) return { key: 'moderate', label: 'ปานกลาง' };
  if (s <= 19) return { key: 'moderately_severe', label: 'ค่อนข้างรุนแรง' };
  return { key: 'severe', label: 'รุนแรง' };
}
function adhdSev(ci, ch) {
  if (ci >= ADHD_CUT && ch >= ADHD_CUT) return { key: 'combined',    label: 'แนวโน้ม ADHD แบบรวม' };
  if (ci >= ADHD_CUT)                   return { key: 'inattentive', label: 'แนวโน้ม ADHD ด้านขาดสมาธิ' };
  if (ch >= ADHD_CUT)                   return { key: 'hyperactive', label: 'แนวโน้ม ADHD ด้านซน/หุนหัน' };
  if (ci >= ADHD_WATCH || ch >= ADHD_WATCH) return { key: 'subclinical', label: 'มีบางอาการ ต้องติดตาม' };
  return { key: 'none', label: 'ไม่พบแนวโน้ม ADHD' };
}
function calcRisk(d) {
  let s = 0;
  if (d.has_computer === 'none') s += 3; if (d.has_computer === 'school_only') s += 1;
  if (d.home_internet === 'none') s += 3; if (d.home_internet === 'mobile_data') s += 1;
  if (d.absence === '7+') s += 3; if (d.absence === '4-6') s += 2;
  if (d.submission_habit === '1') s += 2; if (d.submission_habit === '2') s += 1;
  if (d.computer_skill_level === '1') s += 2; if (d.part_time === 'weekly') s += 2;
  if (d.family_support === '1') s += 2; if (d.sleep_hours === 'under5') s += 1;
  if (d.challenge_attitude === 'avoid') s += 2; if (d.help_seeking === 'skip') s += 2;
  if (d.gpax === 'below2') s += 2;
  return s;
}
function classifyLearner(d) {
  const sk = parseInt(d.computer_skill_level || 0, 10) || 0;
  const gm = { '3.5-4.0': 4, '3.0-3.49': 3, '2.5-2.99': 2, '2.0-2.49': 1, 'below2': 0, 'new': 2 };
  const gp = (gm[d.gpax] !== undefined) ? gm[d.gpax] : 2;
  const sb = parseInt(d.submission_habit || 3, 10) || 3;
  if (sk >= 4 && gp >= 3 && sb >= 4) return 'advanced';
  if ((sk + gp + sb) <= 5 || (sk <= 1 && gp <= 1)) return 'struggling';
  return 'intermediate';
}

// ================================================================
// Sheet helpers
// ================================================================
function fmtThaiTs(d) {
  let y = Number(Utilities.formatDate(d, TZ, 'yyyy'));
  if (y < 2400) y += 543;                         // ปี ค.ศ. → พ.ศ. (ปีที่ Sheets แปลงผิดเป็น 2569 อยู่แล้วจะไม่ถูกบวกซ้ำ)
  return Utilities.formatDate(d, TZ, 'dd/MM/') + y + Utilities.formatDate(d, TZ, ' HH:mm:ss');
}
function nowThai() { return fmtThaiTs(new Date()); }
function cellStr(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtThaiTs(v);
  return String(v);
}

function getSheet(type) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SH[type]);
  const fresh = !sh;
  if (!sh) sh = ss.insertSheet(SH[type]);
  const headers = ensureHeaders(sh, HDR[type]);
  if (fresh) applyTextFormats(sh, headers);
  return sh;
}
function readHeaders(sh) {
  const last = sh.getLastColumn();
  return last ? sh.getRange(1, 1, 1, last).getValues()[0].map(String) : [];
}
// ใช้หัวคอลัมน์ "จริงในชีต" เป็นหลัก แล้วเติมคอลัมน์ที่ขาดต่อท้าย (กันข้อมูลเลื่อนคอลัมน์)
function ensureHeaders(sh, expected) {
  let have = readHeaders(sh);
  if (!have.length || have.every(h => h === '')) {
    const r = sh.getRange(1, 1, 1, expected.length);
    r.setValues([expected]);
    styleHeader(r);
    sh.setFrozenRows(1);
    return expected.slice();
  }
  const missing = expected.filter(h => have.indexOf(h) < 0);
  if (missing.length) {
    const r = sh.getRange(1, have.length + 1, 1, missing.length);
    r.setValues([missing]);
    styleHeader(r);
    have = have.concat(missing);
  }
  return have;
}
function styleHeader(r) { r.setBackground('#E86A2E').setFontColor('#FFFFFF').setFontWeight('bold'); }
function applyTextFormats(sh, headers) {
  const rows = sh.getMaxRows();
  TEXT_COLS.forEach(h => {
    const i = headers.indexOf(h);
    if (i >= 0) sh.getRange(1, i + 1, rows, 1).setNumberFormat('@');
  });
}
function findRow(sh, idCol, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (let r = 0; r < ids.length; r++) if (String(ids[r][0]) === String(id)) return r + 2;
  return -1;
}

function readAll(type) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH[type]);
  if (!sh) return [];
  const vals = sh.getDataRange().getValues();
  if (vals.length <= 1) return [];
  const headers = vals[0].map(String);
  return vals.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map(row => {
      const o = {};
      headers.forEach((h, i) => { o[h] = cellStr(row[i]); });
      return o;
    });
}

// เรียกภายใน lock เท่านั้น
function upsert(type, rec) {
  const sh = getSheet(type);
  const headers = readHeaders(sh);
  let row = findRow(sh, headers.indexOf('_id') + 1, rec._id);
  const isNew = row < 0;
  const prev = isNew ? null : sh.getRange(row, 1, 1, headers.length).getValues()[0];
  const pv = h => (prev ? prev[headers.indexOf(h)] : '');

  let scoresChanged = false;
  if (prev && type !== 'learner') {
    Object.keys(rec).forEach(k => { if (/_q\d+$/.test(k) && String(pv(k)) !== String(rec[k])) scoresChanged = true; });
  }

  const out = headers.map(h => {
    if (h === '_ts')         return (prev && pv('_ts') !== '') ? cellStr(pv('_ts')) : nowThai();
    if (h === 'ai_analysis') return (prev && !scoresChanged) ? cellStr(pv('ai_analysis')) : '';
    if (h === 'alert_ack')   return prev ? cellStr(pv('alert_ack')) : '';
    if (Object.prototype.hasOwnProperty.call(rec, h)) return rec[h];
    return prev ? (pv(h) instanceof Date ? cellStr(pv(h)) : pv(h)) : '';
  });

  if (isNew) row = Math.max(sh.getLastRow(), 1) + 1;
  sh.getRange(row, 1, 1, headers.length).setValues([out]);
  return { sh: sh, row: row, headers: headers, isNew: isNew };
}

// ================================================================
// PHQ-A ข้อ 9  →  ไฮไลต์แถวในชีต (การแจ้งเตือนครูอยู่ที่แดชบอร์ด + ปุ่ม "รับทราบ")
// ================================================================
function handleQ9(info, rec) {
  const color = rec.q9_alert === 'ด่วน' ? '#FECACA' : '#FEF3C7';
  info.sh.getRange(info.row, 1, 1, info.headers.length).setBackground(color);
}

// ================================================================
// AI วิเคราะห์ที่หลังบ้าน (trigger ทุก 5 นาที)  — ไม่ส่งชื่อ-นามสกุลให้ AI
// ================================================================
function processAiQueue() {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return;
  const start = Date.now();
  let done = 0;
  ['phq', 'adhd'].forEach(type => {
    if (done >= AI_MAX_PER_RUN) return;
    findPendingAI(type, AI_MAX_PER_RUN - done).forEach(p => {
      if (Date.now() - start > 240000) return;
      const cache = CacheService.getScriptCache();
      const fk = 'aifail:' + type + ':' + p.id;
      const text = callClaude(key, buildAiPrompt(type, p.rec));
      if (text) { writeAI(type, p.id, text); done++; }
      else { cache.put(fk, String(Number(cache.get(fk) || 0) + 1), 21600); }
    });
  });
}

function findPendingAI(type, limit) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH[type]);
  if (!sh || sh.getLastRow() < 2) return [];
  const headers = readHeaders(sh);
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  const cache = CacheService.getScriptCache();
  const out = [];
  for (let r = 0; r < vals.length && out.length < limit; r++) {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = cellStr(vals[r][i]); });
    if (!rec._id || rec.ai_analysis) continue;
    const total = Number(rec[type + '_total']);
    if (rec[type + '_total'] === '' || !isFinite(total)) continue;
    if (Number(cache.get('aifail:' + type + ':' + rec._id) || 0) >= AI_MAX_RETRY) continue;
    out.push({ id: rec._id, rec: rec });
  }
  return out;
}

function writeAI(type, id, text) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH[type]);
    const headers = readHeaders(sh);
    const row = findRow(sh, headers.indexOf('_id') + 1, id);
    if (row < 0) return;
    const col = headers.indexOf('ai_analysis') + 1;
    if (col < 1) return;
    const cell = sh.getRange(row, col);
    if (String(cell.getValue()) === '') cell.setValue(String(text).slice(0, 4000));
  } finally { lock.releaseLock(); }
}

function buildAiPrompt(type, rec) {
  if (type === 'phq') {
    const hi = [];
    for (let i = 1; i <= 9; i++) { const v = Number(rec['phq_q' + i]); if (v >= 2) hi.push('"' + PHQ_ITEMS[i - 1] + '" (' + v + ')'); }
    const sev = phqSev(Number(rec.phq_total));
    return 'ผลคัดกรอง PHQ-A ของนักเรียนอาชีวศึกษาไทย (ไม่ระบุตัวตน)\n' +
      'ระดับชั้น: ' + (rec.level || '-') + '\n' +
      'คะแนนรวม: ' + rec.phq_total + '/27 ระดับ: ' + sev.label + '\n' +
      'ข้อที่ได้คะแนนสูง (≥2): ' + (hi.join(', ') || 'ไม่มี') + '\n' +
      'ข้อ 9 (ความคิดทำร้ายตนเอง): ' + rec.phq_q9 + '\n\n' +
      'ตอบเป็นภาษาไทย ไม่เกิน 160 คำ ตามหัวข้อ:\n1. **สรุปภาพรวม**\n2. **จุดที่ควรสนใจ**\n3. **คำแนะนำสำหรับครู** (2-3 ข้อ)\n4. **ขั้นตอนต่อไป**';
  }
  const sev = adhdSev(Number(rec.adhd_inatt_cnt), Number(rec.adhd_hyper_cnt));
  return 'ผลคัดกรองพฤติกรรมสมาธิสั้นของนักเรียนอาชีวศึกษาไทย อายุ 14-20 ปี (ไม่ระบุตัวตน)\n' +
    'ระดับชั้น: ' + (rec.level || '-') + '\n' +
    'รวม: ' + rec.adhd_total + '/54 | สมาธิ: ' + rec.adhd_inatt + '/27 | ซน/หุนหัน: ' + rec.adhd_hyper + '/27\n' +
    'จำนวนข้อที่ตอบ "บ่อยครั้ง/บ่อยมาก": ขาดสมาธิ ' + rec.adhd_inatt_cnt + '/9, ซน/หุนหัน ' + rec.adhd_hyper_cnt + '/9 (เกณฑ์ ≥' + ADHD_CUT + ' ข้อต่อด้าน)\n' +
    'ระดับ: ' + sev.label + '\n\n' +
    'ตอบเป็นภาษาไทย ไม่เกิน 180 คำ ตามหัวข้อ:\n1. **สรุปภาพรวม**\n2. **จุดเด่นที่ต้องดูแล**\n3. **แนวทางการสอนที่เหมาะสม** (3 ข้อ)\n4. **ข้อแนะนำเพิ่มเติม**';
}

function callClaude(key, prompt) {
  const system = 'คุณเป็นผู้ช่วยครูที่ปรึกษา/ครูแนะแนวในวิทยาลัยอาชีวศึกษา ผลที่ได้รับเป็นเพียงการคัดกรองเบื้องต้น ไม่ใช่การวินิจฉัยทางการแพทย์ ' +
    'ห้ามระบุว่านักเรียน "เป็นโรค" ใช้ถ้อยคำเชิงบวก ไม่ตีตรา และให้คำแนะนำที่ครูนำไปปฏิบัติได้จริง ' +
    'หากมีข้อ 9 ของ PHQ-A มากกว่า 0 ต้องเน้นให้ติดตามโดยเร็วและประสานผู้เชี่ยวชาญ/สายด่วนสุขภาพจิต 1323';
  try {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({ model: AI_MODEL, max_tokens: 700, system: system, messages: [{ role: 'user', content: prompt }] }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Claude API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
      return '';
    }
    const d = JSON.parse(res.getContentText());
    return (d.content || []).map(c => c.text || '').join('').trim();
  } catch (err) {
    Logger.log('callClaude error: ' + err.message);
    return '';
  }
}

// ================================================================
// Setup / Maintenance  (รันจากตัวแก้ไข Apps Script)
// ================================================================
function setupSheets() {
  Object.keys(SH).forEach(type => {
    const sh = getSheet(type);
    applyTextFormats(sh, readHeaders(sh));
  });
  installTriggers();
  SpreadsheetApp.flush();
}

function installTriggers() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processAiQueue');
  if (!has) ScriptApp.newTrigger('processAiQueue').timeBased().everyMinutes(5).create();
}

// ตั้งรหัสผ่านแอดมิน / API key / อีเมลแจ้งเตือน — เก็บใน Script Properties (ไม่อยู่ในโค้ด)
function setupSecurity() {
  const props = PropertiesService.getScriptProperties();
  const ask = (msg) => Browser.inputBox(msg, Browser.Buttons.OK_CANCEL);

  const u = ask('ตั้งชื่อผู้ใช้แอดมินสำหรับแดชบอร์ด (เช่น teacher_tdb)');
  if (u === 'cancel' || !String(u).trim()) return;
  const p = ask('ตั้งรหัสผ่าน (อย่างน้อย 10 ตัวอักษร ห้ามใช้ admin1234)');
  if (p === 'cancel') return;
  if (!isStrongPass(p)) { Browser.msgBox('รหัสผ่านสั้นเกินไปหรือเดาง่าย — ยกเลิกการตั้งค่า'); return; }

  const salt = Utilities.getUuid();
  props.setProperties({ ADMIN_USER: String(u).trim(), ADMIN_SALT: salt, ADMIN_HASH: hashPass(String(p), salt) });

  const k = ask('วาง Anthropic API key (เว้นว่างถ้าไม่ใช้ AI หรือต้องการคงค่าเดิม)');
  if (k !== 'cancel' && String(k).trim()) props.setProperty('ANTHROPIC_API_KEY', String(k).trim());

  bumpEpoch();   // เซสชันเก่าใช้ไม่ได้
  setupSheets();
  Browser.msgBox('✅ ตั้งค่าเสร็จแล้ว\\nขั้นต่อไป: รัน diagnoseSheets() และ repairSheets() แล้ว Deploy เป็น New version');
}

// ลืมรหัสผ่าน: เจ้าของสคริปต์รันฟังก์ชันนี้เพื่อตั้งรหัสใหม่ (ทุกเซสชันเดิมจะถูกออกจากระบบ)
function resetAdminPassword() {
  const props = PropertiesService.getScriptProperties();
  const p = Browser.inputBox('ตั้งรหัสผ่านใหม่ของแอดมิน (อย่างน้อย 10 ตัวอักษร)', Browser.Buttons.OK_CANCEL);
  if (p === 'cancel') return;
  if (!isStrongPass(p)) { Browser.msgBox('รหัสผ่านสั้นเกินไปหรือเดาง่าย — ไม่มีการเปลี่ยนแปลง'); return; }
  const salt = Utilities.getUuid();
  props.setProperties({ ADMIN_SALT: salt, ADMIN_HASH: hashPass(String(p), salt) });
  bumpEpoch();
  CacheService.getScriptCache().remove('loginfail');
  Browser.msgBox('✅ ตั้งรหัสผ่านใหม่แล้ว\\nชื่อผู้ใช้: ' + (props.getProperty('ADMIN_USER') || '(ยังไม่เคยตั้ง — ให้รัน setupSecurity())'));
}

// ปลดล็อกการเข้าสู่ระบบ (หลังใส่รหัสผิดเกิน 5 ครั้ง)
function unlockLogin() {
  CacheService.getScriptCache().remove('loginfail');
  Browser.msgBox('✅ ปลดล็อกการเข้าสู่ระบบแล้ว');
}

// ตรวจโครงสร้างชีตเดิม (ไม่แสดงชื่อนักเรียน)
function diagnoseSheets() {
  const out = [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SH).forEach(type => {
    const sh = ss.getSheetByName(SH[type]);
    if (!sh) { out.push('[' + type + '] ไม่พบชีต ' + SH[type]); return; }
    const have = readHeaders(sh);
    const exp = HDR[type];
    const missing = exp.filter(h => have.indexOf(h) < 0);
    const extra = have.filter(h => exp.indexOf(h) < 0);
    const common = exp.filter(h => have.indexOf(h) >= 0);
    const orderOk = common.every((h, i) => i === 0 || have.indexOf(h) > have.indexOf(common[i - 1]));
    out.push('[' + type + '] แถวข้อมูล=' + Math.max(sh.getLastRow() - 1, 0) +
      ' | หัวคอลัมน์ขาด=' + (missing.join(',') || '-') + ' | หัวคอลัมน์เกิน=' + (extra.join(',') || '-') + ' | ลำดับตรงกับโค้ด=' + orderOk);
    if (sh.getLastRow() >= 2) {
      const row = sh.getRange(2, 1, 1, have.length).getValues()[0];
      const show = (type === 'phq') ? ['_ts', 'phq_total', 'phq_severity', 'phq_q1', 'phq_q9']
                 : (type === 'adhd') ? ['_ts', 'adhd_total', 'adhd_inatt', 'adhd_hyper', 'adhd_severity']
                 : ['_ts', 'phone', 'gpax', '_risk', 'learning_group'];
      out.push('   ตัวอย่างแถวแรก: ' + show.map(h => {
        const i = have.indexOf(h);
        return h + '=' + (i < 0 ? '(ไม่มีคอลัมน์)' : (row[i] instanceof Date ? 'Date(' + row[i].toISOString() + ')' : typeof row[i] + ':' + String(row[i]).slice(0, 25)));
      }).join(' | '));
      if (type !== 'learner') {
        const all = sh.getRange(2, 1, sh.getLastRow() - 1, have.length).getValues();
        const it = have.indexOf(type + '_total');
        const bad = all.filter(r => it < 0 || r[it] === '' || !isFinite(Number(r[it]))).length;
        out.push('   แถวที่คะแนนรวมไม่ใช่ตัวเลข (ทำให้เกิด NaN) = ' + bad + ' จาก ' + all.length);
        if (type === 'phq') {
          const isv = have.indexOf('phq_severity');
          const swapped = all.filter(r => it >= 0 && isv >= 0 && !isFinite(Number(r[it])) && r[it] !== '' && r[isv] !== '' && isFinite(Number(r[isv]))).length;
          if (swapped) out.push('   ⚠️ พบ ' + swapped + ' แถวที่คอลัมน์ phq_total เก็บ "ชื่อระดับ" และ phq_severity เก็บ "ตัวเลข" (คอลัมน์สลับกัน) → repairSheets() จะคำนวณคืนให้จากคะแนนรายข้อ');
        }
      }
    }
  });
  Logger.log(out.join('\n'));
  Browser.msgBox('ตรวจเสร็จแล้ว — ดูรายละเอียดที่ Execution log (ส่งข้อความนั้นมาให้ผู้พัฒนาตรวจต่อได้)');
}

// ซ่อมข้อมูลเดิม: _ts ที่เป็น Date, เบอร์โทรที่ถูกตัดเลข 0, คะแนนรวม/ระดับที่ผิด (คำนวณใหม่จากรายข้อ)
function repairSheets() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const report = [];
  try {
    Object.keys(SH).forEach(type => {
      const sh = getSheet(type);
      const headers = readHeaders(sh);
      applyTextFormats(sh, headers);
      const last = sh.getLastRow();
      if (last < 2) { report.push('[' + type + '] ไม่มีข้อมูล'); return; }
      const rng = sh.getRange(2, 1, last - 1, headers.length);
      const vals = rng.getValues();
      const ix = h => headers.indexOf(h);
      let ts = 0, ph = 0, recomputed = 0, bad = 0;

      vals.forEach(r => {
        TEXT_COLS.forEach(h => {
          const i = ix(h); if (i < 0) return;
          if (r[i] instanceof Date) { r[i] = fmtThaiTs(r[i]); ts++; }
          else if (typeof r[i] === 'number') {
            let s = String(r[i]);
            if ((h === 'phone' || h === 'parent_phone') && s.length === 9) { s = '0' + s; ph++; }
            r[i] = s;
          }
        });

        if (type === 'phq') {
          const q = []; let ok = true;
          for (let i = 1; i <= 9; i++) { const v = r[ix('phq_q' + i)]; const n = Number(v); if (v === '' || !Number.isInteger(n) || n < 0 || n > 3) { ok = false; break; } q.push(n); }
          if (!ok) { bad++; return; }
          const t = q.reduce((a, b) => a + b, 0);
          if (Number(r[ix('phq_total')]) !== t) { r[ix('phq_total')] = t; recomputed++; }
          const sev = phqSev(t).key;
          if (r[ix('phq_severity')] !== sev) { r[ix('phq_severity')] = sev; recomputed++; }
          if (!r[ix('q9_alert')]) r[ix('q9_alert')] = q[8] >= 2 ? 'ด่วน' : (q[8] === 1 ? 'ติดตาม' : '');
        } else if (type === 'adhd') {
          const a = []; let ok = true;
          for (let i = 1; i <= 18; i++) { const v = r[ix('adhd_q' + i)]; const n = Number(v); if (v === '' || !Number.isInteger(n) || n < 0 || n > 3) { ok = false; break; } a.push(n); }
          if (!ok) { bad++; return; }
          const I = a.slice(0, 9).reduce((x, y) => x + y, 0), H = a.slice(9).reduce((x, y) => x + y, 0);
          const CI = a.slice(0, 9).filter(v => v >= 2).length, CH = a.slice(9).filter(v => v >= 2).length;
          const sev = adhdSev(CI, CH).key;
          if (Number(r[ix('adhd_inatt')]) !== I || Number(r[ix('adhd_hyper')]) !== H || Number(r[ix('adhd_total')]) !== I + H || r[ix('adhd_severity')] !== sev) recomputed++;
          r[ix('adhd_inatt')] = I; r[ix('adhd_hyper')] = H; r[ix('adhd_total')] = I + H;
          r[ix('adhd_inatt_cnt')] = CI; r[ix('adhd_hyper_cnt')] = CH; r[ix('adhd_severity')] = sev;
        } else {
          const d = {}; headers.forEach((h, i) => { d[h] = String(r[i]); });
          const risk = calcRisk(d), grp = classifyLearner(d);
          if (Number(r[ix('_risk')]) !== risk || r[ix('learning_group')] !== grp) recomputed++;
          r[ix('_risk')] = risk; r[ix('learning_group')] = grp;
        }
      });

      rng.setValues(vals);
      report.push('[' + type + '] แถว=' + vals.length + ' | แปลงวันที่=' + ts + ' | เติม 0 เบอร์โทร=' + ph +
        ' | คำนวณคะแนนใหม่=' + recomputed + ' | ข้อมูลรายข้อไม่ครบ (ซ่อมไม่ได้)=' + bad);
    });
  } finally { lock.releaseLock(); }
  Logger.log(report.join('\n'));
  Browser.msgBox('ซ่อมข้อมูลเสร็จแล้ว\\n' + report.join('\\n'));
}

// ================================================================
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
