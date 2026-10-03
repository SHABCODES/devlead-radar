const http=require('node:http'),fs=require('node:fs');
const log=(o)=>fs.appendFileSync('hs.log',JSON.stringify(o)+'\n');
http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
 const send=(c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
 const b=raw?JSON.parse(raw):{};log({m:req.method,u:req.url,b});
 if(req.url.endsWith('/search')){const d=b.filterGroups[0].filters[0].value;
   return d==='existing.io'?send(200,{total:1,results:[{id:'42'}]}):send(200,{total:0,results:[]});}
 const p=b.properties||{};
 if(MODE()==='missingprops'&&('devlead_score' in p))return send(400,{status:'error',message:'Property values were not valid: [{"isValid":false,"message":"Property \\"devlead_score\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"devlead_score"}]',category:'VALIDATION_ERROR'});
 return send(req.method==='POST'?201:200,{id:req.method==='POST'?'7':'42',properties:p});
});}).listen(9003);
function MODE(){try{return fs.readFileSync('mode','utf8').trim()}catch(e){return 'ok'}}
const page=(links)=>'<html><body>'+links.map(l=>`<a href="${l}">x</a>`).join('')+'</body></html>';
http.createServer((req,res)=>{const d=req.url.slice(1);res.writeHead(200,{'Content-Type':'text/html'});
 const pages={
  'scrapeok.io':page(['https://github.com/infraco','https://github.com/infraco/repo']),
  'noisy.io':page(['https://github.com/actions/checkout','https://github.com/actions/setup-node','https://github.com/actions/cache','https://github.com/ghostorg']),
  'nolink.io':page(['/about']),
 };res.end(pages[d]||'<html></html>');}).listen(9004);
