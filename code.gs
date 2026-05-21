// ================================================================
// Code.gs  —  Google Apps Script Web App Backend
// วิทยาลัยเทคนิคประจวบคีรีขันธ์  แผนก ทดธ.
//
// วิธี Deploy:
//   1. วางโค้ดนี้ใน Apps Script (Extensions → Apps Script)
//   2. Deploy → New deployment → Web app
//   3. Execute as: Me  |  Who has access: Anyone
//   4. Copy URL ที่ได้ → ใส่ใน SCRIPT_URL ของ index.html และ dashboard.html
// ================================================================

const SHEET_LEARNER = 'learner_data';
const SHEET_PHQ     = 'phq_data';
const SHEET_ADHD    = 'adhd_data';

// ─── Headers ──────────────────────────────────────────────────
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
// GET — ดึงข้อมูล
// ================================================================
function doGet(e) {
  try {
    const type = (e && e.parameter && e.parameter.type) ? e.parameter.type : 'learner';
    const data = readAll(type);
    return respond({ ok: true, data: data });
  } catch(err) {
    return respond({ ok: false, error: err.message });
  }
}

// ================================================================
// POST — บันทึก/อัปเดตข้อมูล
// ================================================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const type    = payload.type   || 'learner';
    const record  = payload.record;
    if (!record) throw new Error('No record');

    if (record._update) {
      // อัปเดต ai_analysis กลับไป (จาก AI fetch background)
      updateAI(type, record._id, record.ai_analysis);
    } else {
      upsert(type, record);
    }
    return respond({ ok: true, id: record._id });
  } catch(err) {
    return respond({ ok: false, error: err.message });
  }
}

// ================================================================
// อ่านทุก row → array of objects
// ================================================================
function readAll(type) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName(type));
  if (!sheet) return [];
  const vals = sheet.getDataRange().getValues();
  if (vals.length <= 1) return [];
  const headers = vals[0];
  return vals.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

// ================================================================
// Upsert — ถ้ามี _id ซ้ำให้แทนที่, ไม่มีให้เพิ่มแถวใหม่
// ================================================================
function upsert(type, record) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const name    = sheetName(type);
  const headers = headerList(type);
  let   sheet   = ss.getSheetByName(name);

  // สร้าง sheet ใหม่พร้อม header ถ้ายังไม่มี
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const hdrRange = sheet.getRange(1, 1, 1, headers.length);
    hdrRange.setValues([headers]);
    hdrRange.setBackground('#E86A2E').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 120);
  }

  const vals = sheet.getDataRange().getValues();
  const idCol = headers.indexOf('_id'); // index ใน headers
  let existingRow = -1;

  // ค้นหา row ที่มี _id ตรงกัน
  if (vals.length > 1 && record._id) {
    for (let r = 1; r < vals.length; r++) {
      if (String(vals[r][idCol]) === String(record._id)) {
        existingRow = r + 1; // Sheets row number (1-based)
        break;
      }
    }
  }

  const row = headers.map(h => {
    const v = record[h];
    if (Array.isArray(v)) return v.join(', ');
    return (v !== undefined && v !== null) ? v : '';
  });

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

// ================================================================
// updateAI — เขียน ai_analysis กลับไปยัง row ที่มี _id ตรงกัน
// ================================================================
function updateAI(type, id, aiText) {
  if (!id || !aiText) return;
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const name    = sheetName(type);
  const sheet   = ss.getSheetByName(name);
  if (!sheet) return;

  const headers = headerList(type);
  const aiCol   = headers.indexOf('ai_analysis') + 1; // 1-based
  if (aiCol < 1) return;

  const vals = sheet.getDataRange().getValues();
  const idCol = headers.indexOf('_id'); // 0-based

  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][idCol]) === String(id)) {
      sheet.getRange(r + 1, aiCol).setValue(aiText);
      break;
    }
  }
}

// ================================================================
// Helpers
// ================================================================
function sheetName(type) {
  if (type === 'phq')  return SHEET_PHQ;
  if (type === 'adhd') return SHEET_ADHD;
  return SHEET_LEARNER;
}

function headerList(type) {
  if (type === 'phq')  return HDR_PHQ;
  if (type === 'adhd') return HDR_ADHD;
  return HDR_LEARNER;
}

function respond(obj) {
  const output = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}