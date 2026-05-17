async function syncGoogleSheets(data){

  try{

    await fetch('YOUR_WEBAPP_URL',{
      method:'POST',
      headers:{
        'Content-Type':'application/json'
      },
      body:JSON.stringify(data)
    });

  }catch(err){
    console.error(err);
  }
}