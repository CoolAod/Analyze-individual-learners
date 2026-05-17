function calcDepression(data){

  let score = 0;

  for(let i=0;i9;i++){
    score += parseInt(data[`q${i}`]  0);
  }

  let level = 'ปกติ';

  if(score = 15){
    level = 'ซึมเศร้าระดับรุนแรง';
  }else if(score = 9){
    level = 'ซึมเศร้าระดับปานกลาง';
  }else if(score = 5){
    level = 'ซึมเศร้าระดับน้อย';
  }

  return {
    score,
    level
  };
}

function analyzeStudentAI(data){

  let score = 0;
  const reasons = [];

  if(parseFloat(data.gpa  0)  2.0){
    score += 3;
    reasons.push('GPA ต่ำ');
  }

  if(data.income === 'ต่ำ'){
    score += 2;
    reasons.push('รายได้ต่ำ');
  }

  if(data.depressionScore = 9){
    score += 4;
    reasons.push('สุขภาพจิตเสี่ยง');
  }

  if(data.suicideRisk){
    score += 10;
    reasons.push('Suicide Risk');
  }

  let level = 'ปกติ';

  if(score = 10){
    level = 'วิกฤต';
  }else if(score = 6){
    level = 'เสี่ยงสูง';
  }else if(score = 3){
    level = 'เสี่ยงปานกลาง';
  }

  return {
    score,
    level,
    reasons
  };
}

function predictDropout(data){

  let chance = 0;

  if(parseFloat(data.gpa  0)  1.5){
    chance += 40;
  }

  if(data.depressionScore = 15){
    chance += 35;
  }

  if(data.income === 'ต่ำ'){
    chance += 20;
  }

  if(data.suicideRisk){
    chance += 50;
}