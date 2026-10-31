// ================================================================
// Code.gs — Google Apps Script Web App Backend  v4 (Secure)
// ระบบวิเคราะห์ผู้เรียนรายบุคคล
// วิทยาลัยเทคนิคประจวบคีรีขันธ์  แผนก ทดธ.
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
//   2. รัน setupSecurity()  → สร้างชีต "users" + ผู้ใช้แอดมินคนแรก + API key (ไม่บังคับ) ครั้งเดียว
//   3. รัน diagnoseSheets() → ดูผลตรวจโครงสร้างชีตเดิมที่ View → Logs / Execution log
//   4. รัน repairSheets()   → ซ่อมข้อมูลเดิม (วันที่, เบอร์โทร, คะแนนที่เป็น NaN)
//   5. Deploy → Manage deployments → Edit → New version  (Execute as: Me | Anyone)
//      *ต้อง "New version" ทุกครั้งที่แก้โค้ด URL เดิมจึงจะใช้โค้ดใหม่*
//
// จัดการผู้ใช้ (เพิ่ม/ลบ/แก้ไข) ที่ชีต "users" ใน Google Sheets โดยตรง:
//   • เพิ่ม = เพิ่มแถว พิมพ์ username + password ชั่วคราว | ลบ = ลบแถว | เปลี่ยนรหัส = พิมพ์ทับช่อง password
//   • ระงับ/เปิดใช้ = ช่อง active (ใช่/ไม่)
//   • เมนู "👥 ผู้ใช้ระบบ" ในชีต: ตั้งรหัสใหม่ให้ผู้ใช้ / ปลดล็อก / ออกจากระบบทุกเครื่อง
// ลืมรหัสผ่าน: เมนู 👥 ผู้ใช้ระบบ → ตั้งรหัสผ่านใหม่ให้ผู้ใช้… (หรือรัน resetUserPassword())
// ถูกล็อก (ใส่รหัสผิดเกิน 5 ครั้ง): เมนู 👥 → ปลดล็อก (หรือรัน unlockLogin()) | เปลี่ยนรหัสเอง: ปุ่ม 🔑 บนแดชบอร์ด
// ================================================================

const SH = { learner: 'learner_data', phq: 'phq_data', adhd: 'adhd_data' };
const TZ = 'Asia/Bangkok';

const AI_MODEL        = 'claude-sonnet-5-5';   // เปลี่ยนได้ที่นี่ที่เดียว
const AI_MAX_PER_RUN  = 6;                     // วิเคราะห์ไม่เกินกี่คนต่อรอบ trigger
const AI_MAX_RETRY    = 3;
const TOKEN_TTL_SEC   = 21600;                 // 6 ชม. (เพดานของ CacheService)
const MAX_LOGIN_FAILS = 5;                    // ต่อ 1 ชื่อผู้ใช้
const MAX_GLOBAL_FAILS = 60;                  // ทั้งระบบ (กันการเดารหัสแบบสุ่มชื่อ)
const LOGIN_LOCK_SEC  = 600;
const SUBMIT_PER_MIN  = 150;                   // เบรกกันถูกยิงรัว ๆ (ทั้งห้องส่งพร้อมกันยังพอ)

// เกณฑ์คัดกรอง ADHD (อิง DSM-5 / SNAP-IV 18 ข้อ): นับข้อที่ตอบ ≥2 ("บ่อยครั้ง"/"บ่อยมาก")
// ≥ ADHD_CUT จาก 9 ข้อของด้านใดด้านหนึ่ง = มีแนวโน้ม  (DSM-5: 6 ข้อ อายุ ≤16 ปี | 5 ข้อ อายุ ≥17 ปี)
const ADHD_CUT = 6, ADHD_WATCH = 4;

const TEXT_COLS = ['_id', '_ts', 'student_no', 'phone', 'parent_phone', 'alert_ack'];
const LONG_COLS = { addr_subdistrict: 60, addr_district: 60, addr_province: 60, addr_village: 80, commute_van_route: 100, living_with_other: 100, main_supporter_other: 100, student_note: 1000, special_skills: 300, social_platforms: 300, programs_used: 300, digital_biz_exp: 300 };

// ค่าที่อนุญาตของคำถามแบบเลือก (ค่านอกรายการจะถูกล้างเป็นค่าว่าง)
// true = ต้องตอบครบทุกข้อ (แบบสำรวจ + PHQ-A + ADHD) จึงจะบันทึก  (ตั้งเป็น false ถ้าต้องการผ่อนปรนชั่วคราว)
var REQUIRE_COMPLETE = true;

// ค่าที่อนุญาตของคำถามแบบเลือกข้อเดียว (ค่านอกรายการจะถูกล้างเป็นค่าว่าง → นับว่า "ยังไม่ตอบ")
const ENUMS = {
  gender:         ['ชาย', 'หญิง', 'อื่นๆ'],
  gpax:           ['3.5-4.0', '3.0-3.49', '2.5-2.99', '2.0-2.49', 'below2', 'new'],
  commute_mode:   ['van', 'motorcycle', 'car', 'parent_drop', 'walk_dorm', 'other_hire'],
  computer_skill_level: ['1', '2', '3', '4', '5'],
  typing_speed:   ['under20', '20-40', '40-60', 'over60'],
  english_tech:   ['1', '2', '3', '4'],
  problem_solving:['try', 'search', 'ask', 'wait'],
  challenge_attitude: ['excited', 'try_first', 'worry', 'avoid'],
  planning_habit: ['always', 'sometimes', 'rarely', 'never'],
  multitasking:   ['1', '2', '3', '4', '5'],
  submission_habit: ['5', '4', '3', '2', '1'],
  absence:        ['0', '1-3', '4-6', '7+'],
  help_seeking:   ['ask_teacher', 'ask_friend', 'self_study', 'skip'],
  part_time:      ['none', 'weekend', 'weekly'],
  sleep_hours:    ['under5', '5-6', '7-8', 'over8'],
  has_computer:   ['own', 'shared', 'school_only', 'none'],
  home_internet:  ['fast_wifi', 'slow_wifi', 'mobile_data', 'none'],
  smartphone_os:  ['android', 'ios', 'none'],
  uses_ai:        ['often', 'sometimes', 'never'],
  family_support: ['1', '2', '3', '4', '5'],
  parents_status: ['together', 'separated', 'divorced', 'father_deceased', 'mother_deceased', 'both_deceased'],
  living_with:    ['both_parents', 'father', 'mother', 'grandparents', 'relatives', 'guardian', 'other'],
  main_supporter: ['both_parents', 'father', 'mother', 'grandparents', 'relatives', 'self', 'other'],
  career_goal:    ['study_more', 'company', 'own_biz', 'freelance', 'unsure'],
  stress_level:   ['1', '2', '3', '4', '5'],
  living_status:  ['parents', 'relative', 'dorm', 'alone']          // ค่าเดิมของแบบสำรวจรุ่นก่อน (คงไว้เพื่อข้อมูลเก่า ไม่บังคับ)
};
// คำถามเลือกได้หลายข้อ ("none" = ไม่มี/ไม่ใช้ เลือกคู่กับข้ออื่นไม่ได้)
const ENUM_MULTI = {
  programs_used:   ['word', 'excel', 'powerpoint', 'gdocs', 'canva', 'photoshop', 'video', 'code', 'none'],
  digital_biz_exp: ['sell_online', 'content', 'design', 'social', 'web', 'none'],
  learning_style:  ['video', 'practice', 'read', 'listen', 'group'],
  special_skills:  ['video_edit', 'graphic', 'photo', 'code', 'ads', 'seo', 'accounting', 'none'],
  social_platforms:['tiktok', 'facebook', 'instagram', 'youtube', 'x', 'lineoa', 'shopee', 'none']
};
// ฟิลด์ที่ต้องตอบ (นอกจากชนิดเลือกข้างบน)
const REQUIRED_TEXT = ['fullname', 'level', 'classroom', 'student_no', 'phone', 'parent_phone',
  'addr_subdistrict', 'addr_district', 'addr_province', 'addr_village', 'student_note'];
const REQUIRED_INT = ['household_members', 'siblings_count', 'birth_order'];
const INT_FIELDS = { household_members: [1, 30], siblings_count: [0, 20], birth_order: [1, 21], commute_van_price: [0, 30000] };

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
  'addr_subdistrict','addr_district','addr_province','addr_village',
  'commute_mode','commute_van_price','commute_van_route',
  'computer_skill_level','typing_speed','english_tech',
  'problem_solving','learning_style','challenge_attitude','planning_habit','multitasking',
  'submission_habit','absence','help_seeking','part_time','sleep_hours',
  'has_computer','home_internet','smartphone_os','uses_ai',
  'family_support','living_status',
  'household_members','siblings_count','birth_order','parents_status',
  'living_with','living_with_other','main_supporter','main_supporter_other',
  'career_goal','stress_level',
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
  const cache = CacheService.getScriptCache();
  const uname = normUser_(req.username);
  const pass = String(req.password || '');
  const le = lockEpoch_();
  const kU = 'lf:' + le + ':' + uname, kG = 'lfg:' + le;
  if (!uname || Number(cache.get(kU) || 0) >= MAX_LOGIN_FAILS || Number(cache.get(kG) || 0) >= MAX_GLOBAL_FAILS) {
    return { ok: false, error: 'locked' };
  }
  ensureUsersReady_();
  sweepPendingPasswords_();                       // กันกรณี onEdit ไม่ทำงาน (เช่น วางรหัสผ่านจากสคริปต์/แอปมือถือ)
  const u = findUser_(uname);
  // คำนวณ hash เสมอแม้ไม่พบผู้ใช้ เพื่อให้เวลาตอบสนองใกล้เคียงกัน
  const okPass = constEq(hashPass(pass, u ? u.salt : 'x-no-user'), u ? u.hash : 'x-no-hash') && !!u && u.hash !== '';
  if (!u || !okPass) {
    cache.put(kU, String(Number(cache.get(kU) || 0) + 1), LOGIN_LOCK_SEC);
    cache.put(kG, String(Number(cache.get(kG) || 0) + 1), LOGIN_LOCK_SEC);
    Utilities.sleep(700);
    return { ok: false, error: 'invalid' };
  }
  if (!u.active) return { ok: false, error: 'inactive' };          // รหัสถูกแต่บัญชีถูกระงับ
  cache.remove(kU);
  const token = issueToken({ uname: u.uname, h: u.hash.slice(0, 16) });
  touchLastLogin_(u.uname);
  return { ok: true, token: token, name: u.display || u.username, mustChange: u.mustChange, expiresIn: TOKEN_TTL_SEC };
}

function handleLogout(req) {
  const t = String(req.token || '');
  if (t) CacheService.getScriptCache().remove(tokKey(t));
  return { ok: true };
}

// ---------- token / session ----------
// token ผูกกับ "epoch" (รีเซ็ตทุกเครื่องได้) และผูกกับ hash รหัสผ่านของผู้ใช้
// → ลบผู้ใช้, ระงับบัญชี, หรือเปลี่ยนรหัสผ่านในชีต = เซสชันของผู้ใช้นั้นใช้ไม่ได้ทันที (คนอื่นไม่ถูกกระทบ)
function epoch() { return PropertiesService.getScriptProperties().getProperty('TOKEN_EPOCH') || '0'; }
function bumpEpoch() {
  const props = PropertiesService.getScriptProperties();
  const n = String(Number(props.getProperty('TOKEN_EPOCH') || '0') + 1);
  props.setProperty('TOKEN_EPOCH', n);
  return n;
}
function lockEpoch_() { return PropertiesService.getScriptProperties().getProperty('LOCK_EPOCH') || '0'; }
function tokKey(token) { return 'tok:' + epoch() + ':' + token; }
function issueToken(sess) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put(tokKey(token), JSON.stringify(sess), TOKEN_TTL_SEC);
  return token;
}
function getSession(token) {
  const t = String(token || '');
  if (t.length < 40) return null;
  const raw = CacheService.getScriptCache().get(tokKey(t));
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return null; }
  const u = findUser_(s.uname);
  if (!u || !u.active || !u.hash || u.hash.slice(0, 16) !== s.h) return null;
  return { uname: u.uname, user: u, mc: u.mustChange };          // mustChange อ่านสดจากชีตทุกครั้ง
}
function checkToken(token) { return getSession(token); }
function isStrongPass(p) {
  p = String(p);
  return p.length >= 10 && !/admin1234/i.test(p) && new Set(p.split('')).size >= 4;
}

function handleChangePassword(req) {
  const s = getSession(req.token);
  if (!s) return { ok: false, error: 'unauthorized' };
  const cache = CacheService.getScriptCache();
  const kU = 'lf:' + lockEpoch_() + ':' + s.uname;
  const fails = Number(cache.get(kU) || 0);
  if (fails >= MAX_LOGIN_FAILS) return { ok: false, error: 'locked' };
  const oldPw = String(req.oldPassword || ''), newPw = String(req.newPassword || '');
  if (!constEq(hashPass(oldPw, s.user.salt), s.user.hash)) {
    cache.put(kU, String(fails + 1), LOGIN_LOCK_SEC);
    Utilities.sleep(700);
    return { ok: false, error: 'wrong_old' };
  }
  if (!isStrongPass(newPw) || newPw === oldPw) return { ok: false, error: 'weak' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'busy' };
  try {
    const d = readUsers_();
    const u = d.rows.filter(r => r.uname === s.uname)[0];
    if (!u) return { ok: false, error: 'unauthorized' };
    writeUserPassword_(d, u.row, newPw, false);
    const nu = findUser_(s.uname);
    return { ok: true, token: issueToken({ uname: nu.uname, h: nu.hash.slice(0, 16) }) };   // เครื่องที่เปลี่ยนรหัสใช้งานต่อได้ เครื่องอื่นของผู้ใช้นี้หลุด
  } finally { lock.releaseLock(); }
}

// ================================================================
// Users — จัดการผู้ใช้ (เพิ่ม/ลบ/แก้ไข) จากชีต "users" ใน Google Sheets
//   คอลัมน์: username | password | display_name | active | must_change | last_login | note | _salt | _hash
//   • เพิ่มผู้ใช้  = เพิ่มแถวใหม่ พิมพ์ username + password (ชั่วคราว) → ระบบเข้ารหัสแล้วแทนที่ด้วย "(ตั้งรหัสผ่านแล้ว)"
//   • เปลี่ยนรหัสผ่าน = พิมพ์รหัสใหม่ทับช่อง password
//   • ระงับ/เปิดใช้ = ช่อง active (ใช่/ไม่)    • ลบผู้ใช้ = ลบแถว
//   ผู้ใช้ที่ถูกตั้งรหัสจากชีตต้องเปลี่ยนรหัสผ่านเองเมื่อเข้าสู่ระบบครั้งแรก
// ================================================================
const SH_USERS = 'users';
const USERS_HDR = ['username', 'password', 'display_name', 'active', 'must_change', 'last_login', 'note', '_salt', '_hash'];
const PW_MARK = '(ตั้งรหัสผ่านแล้ว)';
const PW_WEAK = '⚠ รหัสผ่านต้องยาว ≥10 ตัวอักษร และไม่เดาง่าย — พิมพ์ใหม่';
const YES = 'ใช่', NO = 'ไม่';

function normUser_(v) { return String(v === null || v === undefined ? '' : v).trim().toLowerCase(); }
function isActive_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return !(s === 'ไม่' || s === 'no' || s === 'n' || s === 'false' || s === '0' || s === 'off' || s === 'ระงับ');
}
function usersSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SH_USERS);
  if (!sh && create) { sh = ss.insertSheet(SH_USERS); formatUsersSheet_(sh); }
  return sh;
}
function formatUsersSheet_(sh) {
  const r = sh.getRange(1, 1, 1, USERS_HDR.length);
  r.setValues([USERS_HDR]);
  styleHeader(r);
  sh.setFrozenRows(1);
  const col = h => USERS_HDR.indexOf(h) + 1;
  try {
    sh.getRange(1, col('username'), sh.getMaxRows(), 2).setNumberFormat('@');          // เก็บเป็นข้อความ (รหัสที่ขึ้นต้นด้วย 0 ไม่เพี้ยน)
    sh.getRange(1, col('username')).setNote('ชื่อผู้ใช้ (ไม่สนตัวพิมพ์เล็ก/ใหญ่)\nเพิ่มผู้ใช้ = เพิ่มแถวใหม่ | ลบผู้ใช้ = ลบทั้งแถว');
    sh.getRange(1, col('password')).setNote('พิมพ์รหัสผ่านใหม่ (≥10 ตัวอักษร) แล้วกด Enter\nระบบจะเข้ารหัสและแทนที่ด้วย "' + PW_MARK + '"\nผู้ใช้ต้องเปลี่ยนรหัสผ่านเองเมื่อเข้าสู่ระบบครั้งแรก\nเปลี่ยนรหัส = พิมพ์รหัสใหม่ทับช่องนี้');
    sh.getRange(1, col('active')).setNote('ใช่ = ใช้งานได้ | ไม่ = ระงับบัญชี (เซสชันที่ล็อกอินอยู่จะหลุดทันที)');
    sh.getRange(1, col('must_change')).setNote('ใช่ = ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน (ระบบตั้งให้เองเมื่อตั้งรหัสจากชีต)');
    sh.getRange(2, col('active'), 500, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([YES, NO], true).setAllowInvalid(false).build());
    sh.setColumnWidths(1, 8, 130);
    sh.hideColumns(col('_salt'), 2);
    sh.getRange(1, col('_salt'), sh.getMaxRows(), 2).protect().setWarningOnly(true).setDescription('ค่าเข้ารหัส — ห้ามแก้ไขเอง');
  } catch (err) { Logger.log('formatUsersSheet_ (cosmetic): ' + err.message); }
}
function readUsers_() {
  const sh = usersSheet_(false);
  const empty = { sh: sh, ix: () => -1, rows: [] };
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 1) return empty;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const ix = h => headers.indexOf(h);
  if (ix('username') < 0 || ix('password') < 0 || ix('_hash') < 0 || ix('_salt') < 0) return empty;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  const g = (r, h) => (ix(h) < 0 ? '' : r[ix(h)]);
  const rows = [];
  vals.forEach((r, i) => {
    const uname = normUser_(g(r, 'username'));
    if (!uname) return;
    rows.push({
      row: i + 2, uname: uname, username: String(g(r, 'username')).trim(),
      password: String(g(r, 'password') === null ? '' : g(r, 'password')),
      display: String(g(r, 'display_name') || '').trim(),
      active: isActive_(g(r, 'active')), mustChange: String(g(r, 'must_change')).trim() === YES,
      salt: String(g(r, '_salt') || ''), hash: String(g(r, '_hash') || '')
    });
  });
  return { sh: sh, ix: ix, rows: rows };
}
function findUser_(uname) {
  const n = normUser_(uname);
  if (!n) return null;
  const rows = readUsers_().rows;
  for (let i = 0; i < rows.length; i++) if (rows[i].uname === n) return rows[i];     // ชื่อซ้ำ → ใช้แถวแรก
  return null;
}
function isPendingPw_(pw) {
  const s = String(pw).trim();
  return s !== '' && s !== PW_MARK && s.charAt(0) !== '⚠';
}
// เขียน salt/hash, ล้างรหัสจริงออกจากช่อง password, ตั้ง must_change
function writeUserPassword_(d, row, plain, mustChange) {
  const sh = d.sh, ix = d.ix, salt = Utilities.getUuid();
  sh.getRange(row, ix('_salt') + 1).setValue(salt);
  sh.getRange(row, ix('_hash') + 1).setValue(hashPass(String(plain), salt));
  sh.getRange(row, ix('password') + 1).setValue(PW_MARK);
  if (ix('must_change') >= 0) sh.getRange(row, ix('must_change') + 1).setValue(mustChange ? YES : '');
  if (ix('active') >= 0) { const c = sh.getRange(row, ix('active') + 1); if (String(c.getValue()).trim() === '') c.setValue(YES); }
}
// แปลงรหัสผ่านที่พิมพ์ในชีตเป็น hash ทุกแถวที่ค้างอยู่ — คืนจำนวนที่ทำสำเร็จ/ที่ปฏิเสธ
function sweepPendingPasswords_() {
  const d = readUsers_();
  let ok = 0, weak = 0;
  d.rows.forEach(u => {
    if (!isPendingPw_(u.password)) return;
    if (isStrongPass(u.password.trim())) { writeUserPassword_(d, u.row, u.password.trim(), true); ok++; }
    else { d.sh.getRange(u.row, d.ix('password') + 1).setValue(PW_WEAK); weak++; }
  });
  return { ok: ok, weak: weak };
}
function toast_(msg) { try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'ผู้ใช้ระบบ', 8); } catch (e) { Logger.log(msg); } }

// ทำงานอัตโนมัติเมื่อมีการแก้ไขชีต (simple trigger)
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (!sh || sh.getName() !== SH_USERS || e.range.getRow() < 2) return;
    const r = sweepPendingPasswords_();
    if (r.ok) toast_('ตั้งรหัสผ่านแล้ว ' + r.ok + ' ราย — ผู้ใช้ต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก');
    if (r.weak) toast_('รหัสผ่านสั้นหรือเดาง่าย ' + r.weak + ' ราย — ต้องยาว ≥10 ตัวอักษร');
    const seen = {}, dup = [];
    readUsers_().rows.forEach(u => { if (seen[u.uname]) dup.push(u.username); seen[u.uname] = 1; });
    if (dup.length) toast_('ชื่อผู้ใช้ซ้ำ: ' + dup.join(', ') + ' (ระบบใช้แถวแรกเท่านั้น)');
  } catch (err) { Logger.log('onEdit: ' + err.message); }
}
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('👥 ผู้ใช้ระบบ')
      .addItem('สร้าง/ตรวจแผ่นงาน users', 'setupUsersSheet')
      .addItem('แปลงรหัสผ่านที่พิมพ์ค้างอยู่', 'menuProcessPasswords')
      .addItem('ตั้งรหัสผ่านใหม่ให้ผู้ใช้…', 'resetUserPassword')
      .addItem('ปลดล็อกการเข้าสู่ระบบ', 'unlockLogin')
      .addItem('ออกจากระบบทุกเครื่อง', 'menuLogoutAll')
      .addToUi();
  } catch (e) { Logger.log('onOpen: ' + e.message); }
}
function touchLastLogin_(uname) {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) return;
    try {
      const d = readUsers_(), u = d.rows.filter(r => r.uname === uname)[0];
      if (u && d.ix('last_login') >= 0) { const c = d.sh.getRange(u.row, d.ix('last_login') + 1); c.setNumberFormat('@'); c.setValue(nowThai()); }
    } finally { lock.releaseLock(); }
  } catch (e) { Logger.log('touchLastLogin_: ' + e.message); }
}
// ย้ายผู้ดูแลเดิม (Script Properties) เข้าชีต users ครั้งเดียว — ใช้รหัสผ่านเดิมได้ต่อ
function migrateLegacyAdmin_() {
  const props = PropertiesService.getScriptProperties();
  const user = props.getProperty('ADMIN_USER'), hash = props.getProperty('ADMIN_HASH'), salt = props.getProperty('ADMIN_SALT');
  if (!user || !hash || !salt) return false;
  const sh = usersSheet_(true);
  const d = readUsers_();
  if (!d.rows.some(r => r.uname === normUser_(user))) {
    const row = Math.max(sh.getLastRow(), 1) + 1;
    const hdr = readHeaders(sh), vals = hdr.map(h => ({ username: user, password: PW_MARK, display_name: user, active: YES, must_change: '', note: 'ย้ายมาจากระบบเดิม', _salt: salt, _hash: hash }[h] || ''));
    sh.getRange(row, 1, 1, hdr.length).setValues([vals]);
  }
  ['ADMIN_USER', 'ADMIN_HASH', 'ADMIN_SALT'].forEach(k => props.deleteProperty(k));
  return true;
}
function ensureUsersReady_() {
  const d = readUsers_();
  if (d.rows.length === 0 && PropertiesService.getScriptProperties().getProperty('ADMIN_HASH')) migrateLegacyAdmin_();
}
function upsertUserWithPassword_(username, plain, mustChange) {
  const sh = usersSheet_(true);
  let d = readUsers_();
  const n = normUser_(username);
  let u = d.rows.filter(r => r.uname === n)[0];
  if (!u) {
    const row = Math.max(sh.getLastRow(), 1) + 1;
    const hdr = readHeaders(sh);
    sh.getRange(row, 1, 1, hdr.length).setValues([hdr.map(h => ({ username: String(username).trim(), display_name: String(username).trim(), active: YES }[h] || ''))]);
    d = readUsers_();
    u = d.rows.filter(r => r.uname === n)[0];
  }
  writeUserPassword_(d, u.row, plain, !!mustChange);
  return u.row;
}

// ครูกด "รับทราบ" ที่แดชบอร์ด → บันทึกเวลาลงคอลัมน์ alert_ack ของชีต phq_data
function handleAck(req) {
  const s = getSession(req.token);
  if (!s) return { ok: false, error: 'unauthorized' };
  if (s.mc) return { ok: false, error: 'must_change' };
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
  const s = getSession(req.token);
  if (!s) return { ok: false, error: 'unauthorized' };
  if (s.mc) return { ok: false, error: 'must_change' };      // ต้องเปลี่ยนรหัสผ่านก่อนจึงจะดูข้อมูลได้
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
  if (REQUIRE_COMPLETE) {
    const miss = missingLearnerFields_(learner);
    if (!phq) miss.push('phq');
    if (!adhd) miss.push('adhd');
    if (miss.length) return { ok: false, error: 'incomplete', missing: miss.slice(0, 30) };
  }

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
    normalizeLearnerExtras(rec);
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

// ตรวจ/ล้างค่าของคำถามชุดที่อยู่-การเดินทาง-ครอบครัว ให้สอดคล้องกัน (ไม่ปฏิเสธทั้งแบบสำรวจ แต่ล้างเฉพาะค่าที่ไม่ถูกต้อง)
function normalizeLearnerExtras(rec) {
  Object.keys(ENUMS).forEach(k => {
    if (rec[k] !== undefined && rec[k] !== '' && ENUMS[k].indexOf(rec[k]) < 0) rec[k] = '';
  });
  // คำถามเลือกหลายข้อ: ตัดค่านอกรายการ, "none" ห้ามอยู่คู่กับข้ออื่น (ขัดกัน → ล้างให้ตอบใหม่)
  Object.keys(ENUM_MULTI).forEach(k => {
    if (rec[k] === undefined || rec[k] === '') return;
    const items = String(rec[k]).split(',').map(s => s.trim()).filter(s => ENUM_MULTI[k].indexOf(s) >= 0);
    const uniq = items.filter((s, i) => items.indexOf(s) === i);
    rec[k] = (uniq.indexOf('none') >= 0 && uniq.length > 1) ? '' : uniq.join(', ');
  });
  // รูปแบบข้อมูล: รหัสนักเรียน (ตัวเลข 6–15 หลัก), เบอร์โทร (9–10 หลัก ขึ้นต้น 0), ความยาวขั้นต่ำของข้อความ
  if (rec.student_no !== undefined && !/^\d{6,15}$/.test(String(rec.student_no).trim())) rec.student_no = '';
  ['phone', 'parent_phone'].forEach(k => {
    if (rec[k] === undefined || rec[k] === '') return;
    const dg = String(rec[k]).replace(/[\s-]/g, '');
    rec[k] = /^0\d{8,9}$/.test(dg) ? dg : '';
  });
  [['fullname', 3], ['addr_subdistrict', 2], ['addr_district', 2], ['addr_province', 2], ['addr_village', 2], ['student_note', 2]].forEach(x => {
    if (rec[x[0]] !== undefined && String(rec[x[0]]).trim().length < x[1]) rec[x[0]] = '';
  });
  Object.keys(INT_FIELDS).forEach(k => {
    const v = rec[k];
    if (v === undefined || v === '') return;
    const n = Number(String(v).trim());
    const r = INT_FIELDS[k];
    rec[k] = (/^\d+$/.test(String(v).trim()) && Number.isInteger(n) && n >= r[0] && n <= r[1]) ? n : '';
  });
  // รถตู้: เก็บราคา/สายเฉพาะเมื่อเลือก "รถตู้ประจำ"
  if (rec.commute_mode !== 'van') { rec.commute_van_price = ''; rec.commute_van_route = ''; }
  // "อื่นๆ": เก็บข้อความระบุเฉพาะเมื่อเลือก "อื่นๆ"
  if (rec.living_with !== 'other') rec.living_with_other = '';
  if (rec.main_supporter !== 'other') rec.main_supporter_other = '';
  // ลำดับการเป็นลูกต้องไม่เกิน (จำนวนพี่น้อง + 1)
  if (rec.birth_order !== undefined && rec.birth_order !== '' && rec.siblings_count !== undefined && rec.siblings_count !== '' &&
      rec.birth_order > rec.siblings_count + 1) rec.birth_order = '';
}

// รายการฟิลด์ที่ "ยังไม่ได้ตอบ/ไม่ถูกต้อง" ของแบบสำรวจ (ใช้เมื่อ REQUIRE_COMPLETE)
function missingLearnerFields_(rec) {
  const miss = [];
  const empty = v => v === undefined || v === null || String(v).trim() === '';
  REQUIRED_TEXT.forEach(k => { if (empty(rec[k])) miss.push(k); });
  Object.keys(ENUMS).forEach(k => { if (k !== 'living_status' && empty(rec[k])) miss.push(k); });
  Object.keys(ENUM_MULTI).forEach(k => { if (empty(rec[k])) miss.push(k); });
  REQUIRED_INT.forEach(k => { if (empty(rec[k])) miss.push(k); });
  if (rec.commute_mode === 'van') {
    if (empty(rec.commute_van_price)) miss.push('commute_van_price');
    if (empty(rec.commute_van_route)) miss.push('commute_van_route');
  }
  if (rec.living_with === 'other' && empty(rec.living_with_other)) miss.push('living_with_other');
  if (rec.main_supporter === 'other' && empty(rec.main_supporter_other)) miss.push('main_supporter_other');
  return miss;
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
  if (fresh) applyTextFormats(sh, headers, type);
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
// คอลัมน์ตัวเลขจริง (ที่เหลือเก็บเป็น "ข้อความ" ทั้งหมด เพื่อกัน Google Sheets แปลงค่าเช่น "5-6" → 5 มิ.ย., "1-3" → 1 มี.ค.)
const NUMERIC_LEARNER = ['_risk', 'household_members', 'siblings_count', 'birth_order', 'commute_van_price'];
function isNumericCol_(type, h) {
  if (type === 'learner') return NUMERIC_LEARNER.indexOf(h) >= 0;
  return /^(phq|adhd)_(total|inatt|hyper|inatt_cnt|hyper_cnt|q\d+)$/.test(h);
}
function colFormat_(type, h) { return isNumericCol_(type, h) ? '0' : '@'; }
function applyTextFormats(sh, headers, type) {
  const rows = sh.getMaxRows();
  headers.forEach((h, i) => {
    if (!h) return;
    if (type) sh.getRange(1, i + 1, rows, 1).setNumberFormat(colFormat_(type, h));
    else if (TEXT_COLS.indexOf(h) >= 0) sh.getRange(1, i + 1, rows, 1).setNumberFormat('@');
  });
}
// ช่องที่มีค่าเป็นช่วงตัวเลขแบบ "5-6" ซึ่งเสี่ยงถูกแปลงเป็นวันที่ — กู้คืนจากวันที่กลับเป็นค่าเดิม
const DATE_ENUM_FIELDS = ['sleep_hours', 'absence', 'typing_speed', 'gpax'];
function recoverEnum_(field, v) {
  let tz = TZ;
  try { tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || TZ; } catch (e) { /* ใช้ TZ เริ่มต้น */ }
  const d = Number(Utilities.formatDate(v, tz, 'd')), m = Number(Utilities.formatDate(v, tz, 'M'));
  const cands = [d + '-' + m, m + '-' + d];            // ลองทั้ง วัน-เดือน และ เดือน-วัน (ตามภาษาของชีต)
  for (let i = 0; i < cands.length; i++) if ((ENUMS[field] || []).indexOf(cands[i]) >= 0) return cands[i];
  return null;
}
function cellStrF_(type, h, v) {
  if (v instanceof Date && type === 'learner' && DATE_ENUM_FIELDS.indexOf(h) >= 0) {
    const r = recoverEnum_(h, v);
    if (r !== null) return r;
  }
  return cellStr(v);
}
function rowFormats_(type, headers) { return [headers.map(h => (h ? colFormat_(type, h) : '@'))]; }
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
      headers.forEach((h, i) => { o[h] = cellStrF_(type, h, row[i]); });
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
    return prev ? (pv(h) instanceof Date ? cellStrF_(type, h, pv(h)) : pv(h)) : '';
  });

  if (isNew) row = Math.max(sh.getLastRow(), 1) + 1;
  const rowRange = sh.getRange(row, 1, 1, headers.length);
  rowRange.setNumberFormats(rowFormats_(type, headers));     // ตั้งรูปแบบก่อนเขียน กันค่าถูกแปลงเป็นวันที่/ตัวเลข
  rowRange.setValues([out]);
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
    applyTextFormats(sh, readHeaders(sh), type);
  });
  installTriggers();
  SpreadsheetApp.flush();
}

function installTriggers() {
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processAiQueue');
  if (!has) ScriptApp.newTrigger('processAiQueue').timeBased().everyMinutes(5).create();
}

// สร้าง/ตรวจแผ่นงาน "users" (ย้ายผู้ดูแลเดิมเข้าชีตให้อัตโนมัติ และแปลงรหัสผ่านที่พิมพ์ค้างอยู่)
function setupUsersSheet() {
  const existed = !!usersSheet_(false);
  const sh = usersSheet_(true);
  if (existed) { ensureHeaders(sh, USERS_HDR); }
  const migrated = migrateLegacyAdmin_();
  const r = sweepPendingPasswords_();
  Browser.msgBox('✅ แผ่นงาน "users" พร้อมใช้งาน' + (migrated ? '\\nย้ายผู้ดูแลเดิมเข้าชีตแล้ว (ใช้รหัสผ่านเดิมได้)' : '') +
    (r.ok ? '\\nตั้งรหัสผ่านให้ ' + r.ok + ' ราย' : '') + '\\nเพิ่ม/ลบ/แก้ไขผู้ใช้ได้ที่ชีตนี้โดยตรง');
}

// ตั้งค่าครั้งแรก: ผู้ใช้แอดมินคนแรก + API key (ไม่บังคับ) — รหัสผ่านเก็บเป็น hash ในชีต users, API key เก็บใน Script Properties
function setupSecurity() {
  const props = PropertiesService.getScriptProperties();
  const ask = (msg) => Browser.inputBox(msg, Browser.Buttons.OK_CANCEL);

  usersSheet_(true);
  migrateLegacyAdmin_();
  const u = ask('เพิ่มผู้ใช้แอดมิน: พิมพ์ชื่อผู้ใช้\\n(เว้นว่างถ้ามีผู้ใช้ในชีต "users" แล้ว — เพิ่ม/ลบ/แก้ไขผู้ใช้ได้ในชีตนั้นโดยตรง)');
  if (u === 'cancel') return;
  if (String(u).trim()) {
    const p = ask('ตั้งรหัสผ่านของ "' + String(u).trim() + '" (อย่างน้อย 10 ตัวอักษร ห้ามใช้ admin1234)');
    if (p === 'cancel') return;
    if (!isStrongPass(p)) { Browser.msgBox('รหัสผ่านสั้นเกินไปหรือเดาง่าย — ยกเลิกการตั้งค่า'); return; }
    upsertUserWithPassword_(String(u).trim(), String(p), false);
  }
  const k = ask('วาง Anthropic API key (เว้นว่างถ้าไม่ใช้ AI หรือต้องการคงค่าเดิม)');
  if (k !== 'cancel' && String(k).trim()) props.setProperty('ANTHROPIC_API_KEY', String(k).trim());

  bumpEpoch();   // เซสชันเก่าใช้ไม่ได้
  setupSheets();
  Browser.msgBox('✅ ตั้งค่าเสร็จแล้ว\\nจัดการผู้ใช้ที่ชีต "users" | ขั้นต่อไป: รัน diagnoseSheets() และ repairSheets() แล้ว Deploy เป็น New version');
}

// ลืมรหัสผ่าน: เจ้าของสคริปต์ (หรือเมนู 👥 ผู้ใช้ระบบ) ตั้งรหัสใหม่ให้ผู้ใช้ — ถ้าชื่อนี้ยังไม่มีจะสร้างผู้ใช้ใหม่
function resetUserPassword() {
  const ask = (msg) => Browser.inputBox(msg, Browser.Buttons.OK_CANCEL);
  const names = readUsers_().rows.map(r => r.username);
  const u = ask('ชื่อผู้ใช้ที่ต้องการตั้งรหัสผ่านใหม่' + (names.length ? '\\nผู้ใช้ในระบบตอนนี้: ' + names.join(', ') : '') + '\\n(ถ้าพิมพ์ชื่อใหม่ จะสร้างผู้ใช้ใหม่)');
  if (u === 'cancel' || !String(u).trim()) return;
  const p = ask('รหัสผ่านใหม่ของ "' + String(u).trim() + '" (อย่างน้อย 10 ตัวอักษร)');
  if (p === 'cancel') return;
  if (!isStrongPass(p)) { Browser.msgBox('รหัสผ่านสั้นเกินไปหรือเดาง่าย — ไม่มีการเปลี่ยนแปลง'); return; }
  upsertUserWithPassword_(String(u).trim(), String(p), false);
  CacheService.getScriptCache().remove('lf:' + lockEpoch_() + ':' + normUser_(u));
  Browser.msgBox('✅ ตั้งรหัสผ่านใหม่ให้ "' + String(u).trim() + '" แล้ว\\n(เซสชันเดิมของผู้ใช้นี้ถูกยกเลิกอัตโนมัติ)');
}
function resetAdminPassword() { resetUserPassword(); }      // ชื่อเดิม ใช้ได้ต่อ

// ปลดล็อกการเข้าสู่ระบบของทุกบัญชี (หลังใส่รหัสผิดเกิน 5 ครั้ง)
function unlockLogin() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('LOCK_EPOCH', String(Number(props.getProperty('LOCK_EPOCH') || '0') + 1));
  Browser.msgBox('✅ ปลดล็อกการเข้าสู่ระบบแล้ว');
}
function menuProcessPasswords() {
  const r = sweepPendingPasswords_();
  Browser.msgBox(r.ok || r.weak ? ('ตั้งรหัสผ่านสำเร็จ ' + r.ok + ' ราย' + (r.weak ? ' | ถูกปฏิเสธ (สั้น/เดาง่าย) ' + r.weak + ' ราย' : '')) : 'ไม่มีรหัสผ่านที่พิมพ์ค้างอยู่');
}
function menuLogoutAll() { bumpEpoch(); Browser.msgBox('✅ ออกจากระบบทุกเครื่องแล้ว'); }

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
      const last = sh.getLastRow();
      if (last < 2) { applyTextFormats(sh, headers, type); report.push('[' + type + '] ไม่มีข้อมูล'); return; }
      const rng = sh.getRange(2, 1, last - 1, headers.length);
      const vals = rng.getValues();
      const ix = h => headers.indexOf(h);
      let ts = 0, ph = 0, recomputed = 0, bad = 0, enumFixed = 0;
      const otherDates = {};

      vals.forEach(r => {
        // ค่าที่ถูก Sheets แปลงเป็นวันที่ (เช่น ชั่วโมงนอน "5-6", ขาดเรียน "1-3") → กู้กลับเป็นค่าเดิม
        if (type === 'learner') {
          headers.forEach((h, i) => {
            if (!(r[i] instanceof Date) || TEXT_COLS.indexOf(h) >= 0) return;
            if (DATE_ENUM_FIELDS.indexOf(h) >= 0) { const rv = recoverEnum_(h, r[i]); if (rv !== null) { r[i] = rv; enumFixed++; return; } }
            otherDates[h] = (otherDates[h] || 0) + 1;
          });
        }
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

      applyTextFormats(sh, headers, type);                         // ตั้งรูปแบบคอลัมน์ใหม่หลังอ่านค่าแล้ว
      rng.setNumberFormats(vals.map(() => rowFormats_(type, headers)[0]));
      rng.setValues(vals);
      const od = Object.keys(otherDates);
      report.push('[' + type + '] แถว=' + vals.length + ' | แปลงวันที่=' + ts + ' | กู้ค่าที่ถูกแปลงเป็นวันที่=' + enumFixed + ' | เติม 0 เบอร์โทร=' + ph +
        ' | คำนวณคะแนนใหม่=' + recomputed + ' | ข้อมูลรายข้อไม่ครบ (ซ่อมไม่ได้)=' + bad +
        (od.length ? ' | ⚠ มีเซลล์ที่ถูกแปลงเป็นวันที่และกู้ไม่ได้ในคอลัมน์: ' + od.join(', ') : ''));
    });
  } finally { lock.releaseLock(); }
  Logger.log(report.join('\n'));
  Browser.msgBox('ซ่อมข้อมูลเสร็จแล้ว\\n' + report.join('\\n'));
}

// ================================================================
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
