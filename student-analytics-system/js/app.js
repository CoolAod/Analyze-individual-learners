const QUESTIONS = [
'เบื่อ ทำอะไรก็ไม่เพลิดเพลิน ไม่มีความสุข',
'ไม่สบายใจ ซึมเศร้า ท้อแท้ หรือสิ้นหวัง',
'หลับยาก ตื่นกลางดึก หรือนอนมากเกินไป',
'เหนื่อยง่าย อ่อนเพลีย ไม่มีแรง',
'เบื่ออาหาร หรือกินมากเกินไป',
'รู้สึกไม่ดีกับตัวเอง คิดว่าตัวเองล้มเหลว',
'สมาธิเสียเวลาทำสิ่งต่างๆ',
'พูดหรือทำอะไรช้าลง หรือกระสับกระส่าย',
'คิดทำร้ายตัวเอง หรือคิดว่าถ้าตายไปคงจะดีกว่า'
];

function buildQuestions(){

  const box = document.getElementById('questions');

  box.innerHTML = QUESTIONS.map((q,i)=>`
  <div class="field">
    <label>${i+1}. ${q}</label>

    <div class="scale">

      <label><input type="radio" name="q${i}" value="0" required>ไม่มีเลย</label>
      <label><input type="radio" name="q${i}" value="1">บางวัน</label>
      <label><input type="radio" name="q${i}" value="2">บ่อย</label>
      <label><input type="radio" name="q${i}" value="3">ทุกวัน</label>

    </div>
  </div>
  `).join('');
}

buildQuestions();

function loadStudents(){

  try{
    return JSON.parse(localStorage.getItem('students') || '[]');
  }catch(err){
    return [];
  }
}

function saveStudents(data){

  const all = loadStudents();

  all.push(data);

  localStorage.setItem('students',JSON.stringify(all));
}

const form = document.getElementById('studentForm');

form.addEventListener('submit',async e=>{

  e.preventDefault();

  const data = {
    fullname:fullname.value,
    classroom:classroom.value,
    phone:phone.value,
    gpa:gpa.value,
    income:income.value,
    createdAt:new Date().toISOString()
  };

  for(let i=0;i<9;i++){

    const checked = document.querySelector(`input[name="q${i}"]:checked`);

    data[`q${i}`] = checked ? checked.value : 0;
  }

  const dep = calcDepression(data);

  data.depressionScore = dep.score;
  data.depressionLevel = dep.level;
}