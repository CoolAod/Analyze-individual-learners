// ===============================
// dashboard.js
// Student Analytics Dashboard
// ===============================

// โหลดข้อมูลจาก localStorage
function loadStudents() {

  try {

    return JSON.parse(
      localStorage.getItem('students') || '[]'
    );

  } catch (err) {

    console.error('Load Error:', err);

    return [];
  }
}

// Escape HTML ป้องกัน XSS
function escapeHTML(str = '') {

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ===============================
// Render Dashboard
// ===============================
function renderDashboard() {

  const students = loadStudents();

  renderStats(students);

  renderTable(students);

  renderChart(students);
}

// ===============================
// Render Stats
// ===============================
function renderStats(data) {

  const total = data.length;

  const risk = data.filter(
    d => d.aiLevel !== 'ปกติ'
  ).length;

  const depression = data.filter(
    d => d.depressionScore >= 9
  ).length;

  const suicide = data.filter(
    d => d.suicideRisk
  ).length;

  document.getElementById(
    'totalStudents'
  ).textContent = total;

  document.getElementById(
    'riskStudents'
  ).textContent = risk;

  document.getElementById(
    'depressionStudents'
  ).textContent = depression;

  document.getElementById(
    'suicideStudents'
  ).textContent = suicide;
}

// ===============================
// Render Table
// ===============================
function renderTable(data) {

  const tbody =
    document.getElementById('studentTable');

  if (!tbody) return;

  tbody.innerHTML = data.map(student => {

    const riskClass =
      student.aiLevel === 'วิกฤต'
        ? 'red'
        : student.aiLevel === 'เสี่ยงสูง'
          ? 'orange'
          : 'green';

    const depClass =
      student.depressionScore >= 15
        ? 'red'
        : student.depressionScore >= 9
          ? 'orange'
          : 'green';

    return `
      <tr>

        <td>
          ${escapeHTML(student.fullname)}
        </td>

        <td>
          ${escapeHTML(student.classroom)}
        </td>

        <td>
          <span class="badge ${riskClass}">
            ${escapeHTML(student.aiLevel || 'ปกติ')}
          </span>
        </td>

        <td>
          ${student.dropoutChance || 0}%
        </td>

        <td>
          <span class="badge ${depClass}">
            ${escapeHTML(student.depressionLevel || 'ปกติ')}
          </span>
        </td>

        <td>
          ${
            student.suicideRisk
              ? '<span class="badge red">⚠️ ALERT</span>'
              : '-'
          }
        </td>

      </tr>
    `;

  }).join('');
}

// ===============================
// Render Chart
// ===============================
let chartInstance = null;

function renderChart(data) {

  const chartCanvas =
    document.getElementById('riskChart');

  if (!chartCanvas) return;

  let normal = 0;
  let medium = 0;
  let high = 0;
  let critical = 0;

  data.forEach(student => {

    switch (student.aiLevel) {

      case 'เสี่ยงปานกลาง':
        medium++;
        break;

      case 'เสี่ยงสูง':
        high++;
        break;

      case 'วิกฤต':
        critical++;
        break;

      default:
        normal++;
    }
  });

  // ป้องกัน Chart ซ้อน
  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(chartCanvas, {

    type: 'bar',

    data: {

      labels: [
        'ปกติ',
        'ปานกลาง',
        'สูง',
        'วิกฤต'
      ],

      datasets: [{
        label: 'จำนวนนักเรียน',

        data: [
          normal,
          medium,
          high,
          critical
        ]
      }]
    },

    options: {

      responsive: true,

      maintainAspectRatio: false,

      plugins: {

        legend: {
          display: true
        }
      },

      scales: {

        y: {
          beginAtZero: true
        }
      }
    }
  });
}

// ===============================
// Export CSV
// ===============================
function exportCSV() {

  const data = loadStudents();

  if (!data.length) {

    alert('ไม่มีข้อมูล');

    return;
  }

  const rows = [[
    'ชื่อ',
    'ห้อง',
    'AI Risk',
    'Dropout',
    'PHQ-9',
    'Suicide Risk'
  ]];

  data.forEach(student => {

    rows.push([

      `"${student.fullname || ''}"`,

      `"${student.classroom || ''}"`,

      `"${student.aiLevel || ''}"`,

      `"${student.dropoutChance || 0}%"`,

      `"${student.depressionLevel || ''}"`,

      student.suicideRisk
        ? 'YES'
        : 'NO'
    ]);
  });

  const csv =
    rows.map(r => r.join(',')).join('\n');

  const blob = new Blob(
    ['\uFEFF' + csv],
    {
      type: 'text/csv;charset=utf-8;'
    }
  );

  const url =
    URL.createObjectURL(blob);

  const link =
    document.createElement('a');

  link.href = url;

  link.download =
    'student_analytics.csv';

  link.click();

  URL.revokeObjectURL(url);
}

// ===============================
// Export PDF
// ===============================
async function exportPDF() {

  const data = loadStudents();

  if (!data.length) {

    alert('ไม่มีข้อมูล');

    return;
  }

  const { jsPDF } = window.jspdf;

  const doc = new jsPDF();

  let y = 20;

  doc.setFontSize(18);

  doc.text(
    'Student Analytics Report',
    20,
    y
  );

  y += 20;

  data.forEach((student, index) => {

    doc.setFontSize(12);

    doc.text(
      `${index + 1}. ${student.fullname}`,
      20,
      y
    );

    y += 8;

    doc.text(
      `Class: ${student.classroom}`,
      25,
      y
    );

    y += 8;

    doc.text(
      `AI Risk: ${student.aiLevel}`,
      25,
      y
    );

    y += 8;

    doc.text(
      `Dropout: ${student.dropoutChance}%`,
      25,
      y
    );

    y += 8;

    doc.text(
      `PHQ-9: ${student.depressionLevel}`,
      25,
      y
    );

    y += 12;

    if (y >= 270) {

      doc.addPage();

      y = 20;
    }
  });

  doc.save('student_report.pdf');
}

// ===============================
// Search Student
// ===============================
function searchStudent(keyword) {

  const students = loadStudents();

  const filtered = students.filter(student => {

    return (
      student.fullname
        .toLowerCase()
        .includes(keyword.toLowerCase())
      ||
      student.classroom
        .toLowerCase()
        .includes(keyword.toLowerCase())
    );
  });

  renderTable(filtered);
}

// ===============================
// Real-time Refresh
// ===============================
window.addEventListener(
  'storage',
  renderDashboard
);

// ===============================
// Start App
// ===============================
document.addEventListener(
  'DOMContentLoaded',
  () => {

    renderDashboard();

    // Search Box
    const searchInput =
      document.getElementById('searchInput');

    if (searchInput) {

      searchInput.addEventListener(
        'keyup',
        e => {

          searchStudent(e.target.value);
        }
      );
    }
  }
);