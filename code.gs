// ================================================================
// Code.gs  —  Google Apps Script Web App Backend  v3-FINAL
// ระบบวิเคราะห์ผู้เรียนรายบุคคล
// วิทยาลัยเทคนิคประจวบคีรีขันธ์  แผนก ทดธ.
//
// วิธีใช้:
//   1. วางโค้ดนี้ใน Apps Script (Extensions → Apps Script)
//   2. รัน setupSheets() ครั้งแรกเพื่อสร้าง sheet
//   3. Deploy → New deployment → Web app
//      Execute as: Me | Who has access: Anyone
//   4. Copy URL ไปใส่ใน SCRIPT_URL ของ index.html และ dashboard.html
// ================================================================

const SH_LEARNER = 'learner_data';
const SH_PHQ     = 'phq_data';
const SH_ADHD    = 'adhd_data';

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
  'ai_analysis'
];
const HDR_ADHD = [
  '_id','_ts','fullname','level','classroom','gender',
  'adhd_total','adhd_inatt','adhd_hyper','adhd_severity',
  'adhd_q1','adhd_q2','adhd_q3','adhd_q4','adhd_q5','adhd_q6',
  'adhd_q7','adhd_q8','adhd_q9','adhd_q10','adhd_q11','adhd_q12',
  'adhd_q13','adhd_q14','adhd_q15','adhd_q16','adhd_q17','adhd_q18',
  'ai_analysis'
];

// ================================================================
// GET
// ================================================================
function doGet(e) {
  try {
    const type = (e && e.parameter && e.parameter.type) ? e.parameter.type : 'learner';
    const data = readAll(type);
    return jsonOut({ ok: true, data: data });
  } catch(err) {
    Logger.log('doGet error: ' + err.message);
    return jsonOut({ ok: false, error: err.message });
  }
}

// ================================================================
// POST
// ================================================================
function doPost(e) {
  try {
    const body    = e.postData ? e.postData.contents : '{}';
    const payload = JSON.parse(body);
    const type    = payload.type || 'learner';
    const record  = payload.record;
    if (!record) throw new Error('No record');

    if (record._update) {
      updateAI(type, record._id, record.ai_analysis);
    } else {
      upsert(type, record);
    }
    return jsonOut({ ok: true, id: record._id || '' });
  } catch(err) {
    Logger.log('doPost error: ' + err.message);
    return jsonOut({ ok: false, error: err.message });
  }
}

// ================================================================
// readAll
// ================================================================
function readAll(type) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName(type));
  if (!sheet) return [];
  const vals = sheet.getDataRange().getValues();
  if (vals.length <= 1) return [];
  const headers = vals[0].map(String);
  return vals.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      const v = row[i];
      obj[h] = (v !== undefined && v !== null) ? String(v) : '';
    });
    return obj;
  });
}

// ================================================================
// upsert
// ================================================================
function upsert(type, record) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const name    = sheetName(type);
  const headers = hdrList(type);
  let   sheet   = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    setupHeader(sheet, headers);
  }

  const idIdx = headers.indexOf('_id');
  const allVals = sheet.getDataRange().getValues();
  let existRow = -1;

  if (record._id && allVals.length > 1) {
    for (let r = 1; r < allVals.length; r++) {
      if (String(allVals[r][idIdx]) === String(record._id)) {
        existRow = r + 1;
        break;
      }
    }
  }

  const row = headers.map(h => {
    const v = record[h];
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  });

  if (existRow > 0) {
    sheet.getRange(existRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  SpreadsheetApp.flush();
}

// ================================================================
// updateAI
// ================================================================
function updateAI(type, id, aiText) {
  if (!id || !aiText) return;
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(sheetName(type));
  if (!sheet) return;

  const headers = hdrList(type);
  const aiCol   = headers.indexOf('ai_analysis') + 1;
  const idIdx   = headers.indexOf('_id');
  if (aiCol < 1) return;

  const vals = sheet.getDataRange().getValues();
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][idIdx]) === String(id)) {
      sheet.getRange(r + 1, aiCol).setValue(String(aiText));
      SpreadsheetApp.flush();
      return;
    }
  }
}

// ================================================================
// setupSheets — รันครั้งแรก เพื่อสร้าง sheet ให้ครบ
// ================================================================
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ['learner', 'phq', 'adhd'].forEach(type => {
    const name    = sheetName(type);
    const headers = hdrList(type);
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    setupHeader(sheet, headers);
    Logger.log('✅ Sheet ready: ' + name);
  });
  SpreadsheetApp.flush();
  Browser.msgBox('✅ Setup เสร็จแล้ว!\nสร้าง Sheet: learner_data, phq_data, adhd_data');
}

// ================================================================
// Helpers
// ================================================================
function sheetName(type) {
  if (type === 'phq')  return SH_PHQ;
  if (type === 'adhd') return SH_ADHD;
  return SH_LEARNER;
}
function hdrList(type) {
  if (type === 'phq')  return HDR_PHQ;
  if (type === 'adhd') return HDR_ADHD;
  return HDR_LEARNER;
}
function setupHeader(sheet, headers) {
  const r = sheet.getRange(1, 1, 1, headers.length);
  r.setValues([headers]);
  r.setBackground('#E86A2E').setFontColor('#FFFFFF').setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, headers.length, 120);
}
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
