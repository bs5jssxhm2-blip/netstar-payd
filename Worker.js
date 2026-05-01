const NETSTAR_BASE = "https://fleetai-api.netstaraus.com.au";
const UBI_BASE = "https://ubi-api.netstaraus.com.au";
const NETSTAR_API_KEY = "aROAW0rN00qS3Ar5iOnog";
const COMPANY = "Netstar Demo";
const LOCATION = "Netstar Demo";
const DATE_FROM = "07-04-2026 00:00:01";
const DATE_TO = "13-04-2026 23:59:59";
const GITHUB_RAW = "https://raw.githubusercontent.com/bs5jssxhm2-blip/Netstar-proxy/main";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

function cors(){return{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,x-api-key,Authorization","Access-Control-Max-Age":"86400"};}
function json(data,status){status=status||200;return new Response(JSON.stringify(data),{status:status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});}
function err(msg,status){return json({error:msg},status||400);}
function pad(n){return String(n).padStart(2,"0");}
function toNetstar(s,endOfDay){if(!s)return null;var d=new Date(s);if(isNaN(d))return null;if(endOfDay)d.setUTCHours(23,59,59);return pad(d.getUTCDate())+"-"+pad(d.getUTCMonth()+1)+"-"+d.getUTCFullYear()+" "+pad(d.getUTCHours())+":"+pad(d.getUTCMinutes())+":"+pad(d.getUTCSeconds());}
function safe(v){var n=parseFloat(v);return isNaN(n)||n<0?0:n;}

async function getSpeedLimit(lat,lon){
  try{
    var q="[out:json][timeout:8];way(around:80,"+lat+","+lon+")[highway][maxspeed];out tags 1;";
    var res=await fetch(OVERPASS_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"NetstarPAYD/1.0 shaunbr@netstaraus.com.au"},body:"data="+encodeURIComponent(q)});
    var data=await res.json();
    var elements=data.elements||[];
    if(elements.length>0){
      var ms=elements[0].tags&&elements[0].tags.maxspeed;
      if(ms){var limit=parseInt(ms);if(!isNaN(limit))return limit;}
    }
    var q2="[out:json][timeout:8];way(around:80,"+lat+","+lon+")[highway];out tags 1;";
    var res2=await fetch(OVERPASS_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"NetstarPAYD/1.0 shaunbr@netstaraus.com.au"},body:"data="+encodeURIComponent(q2)});
    var data2=await res2.json();
    var elements2=data2.elements||[];
    if(elements2.length>0){
      var hw=elements2[0].tags&&elements2[0].tags.highway;
      var defaults={motorway:110,trunk:110,primary:80,secondary:80,tertiary:60,residential:50,living_street:10,service:20,unclassified:60};
      if(hw&&defaults[hw])return defaults[hw];
    }
  }catch(e){}
  return null;
}

function calcSpeedPenalty(vehicleSpeed,postedLimit){
  if(!postedLimit||vehicleSpeed<=0)return{penalty:0,pct_over:0,posted:postedLimit};
  var pct=(vehicleSpeed-postedLimit)/postedLimit*100;
  if(pct<=0)return{penalty:0,pct_over:0,posted:postedLimit};
  var penalty=0;
  if(pct>=50)penalty=25;
  else if(pct>=30)penalty=18;
  else if(pct>=20)penalty=12;
  else if(pct>=10)penalty=6;
  else penalty=2;
  return{penalty:penalty,pct_over:Math.round(pct),posted:postedLimit};
}

function calcRisk(r,speedPenaltyOverride){
  var braking=safe(r.harsh_breaking||0),accel=safe(r.harsh_acceleration||0),cornering=safe(r.harsh_cornering||0);
  var speeding=safe(r.over_speed||0),night=safe(r.night_drive||0),idling=safe(r.idling||0);
  var avgSpd=safe(r.avg_speed||0),maxSpd=safe(r.max_speed||0),km=safe(r.total_running_km||0);
  var per100=km>0?100/km:1;
  var eventScore=(braking*3.0*per100)+(accel*2.5*per100)+(cornering*2.0*per100)+(speeding*3.5*per100)+(night*1.5*per100)+(idling*0.5*per100);
  var speedPenalty=0;
  if(speedPenaltyOverride!=null){
    speedPenalty=speedPenaltyOverride;
  } else {
    if(avgSpd>80)speedPenalty+=15;else if(avgSpd>60)speedPenalty+=5;
    if(maxSpd>130)speedPenalty+=20;else if(maxSpd>110)speedPenalty+=10;else if(maxSpd>100)speedPenalty+=5;
  }
  var raw=Math.min(eventScore*10+speedPenalty,100);
  return{risk_score:Math.round(Math.min(Math.max(raw,0),100)*10)/10,features:{harsh_breaking:braking,harsh_acceleration:accel,harsh_cornering:cornering,over_speed:speeding,night_drive:night,idling:idling}};
}

function lossCost(sc,km){km=km||15000;return Math.round(1200*(Math.exp(sc/35)-0.9)*Math.sqrt(km/15000));}
function riskBand(sc){if(sc<20)return"Excellent";if(sc<40)return"Good";if(sc<60)return"Moderate";if(sc<80)return"High";return"Critical";}

async function ubiGET(path){
  var res=await fetch(UBI_BASE+path,{method:"GET",headers:{"x-api-key":NETSTAR_API_KEY,"Accept":"application/json"}});
  var text=await res.text();
  if(!res.ok)throw new Error("UBI "+res.status+": "+text.slice(0,300));
  try{return JSON.parse(text);}catch(e){throw new Error("Non-JSON: "+text.slice(0,300));}
}

async function getDriverPerf(start,end){
  var q=new URLSearchParams({company_names:COMPANY,location_names:LOCATION,start_date_time:start,end_date_time:end});
  var res=await fetch(NETSTAR_BASE+"/external/drivers/driver-performance-summary?"+q.toString(),{method:"GET",headers:{"x-api-key":NETSTAR_API_KEY,"Accept":"application/json"}});
  var text=await res.text();
  if(!res.ok)throw new Error("Netstar "+res.status+": "+text.slice(0,300));
  var data=JSON.parse(text);
  if(data.status==="fail")throw new Error(data.message||"Driver performance request failed");
  return Array.isArray(data)?data:(data.data||data.result||[]);
}

async function getObjectStatus(imei){
  var res=await fetch(NETSTAR_BASE+"/external/reports/object-status?imei="+imei,{method:"GET",headers:{"x-api-key":NETSTAR_API_KEY,"Accept":"application/json"}});
  var text=await res.text();
  if(!res.ok)return null;
  try{var data=JSON.parse(text);var list=Array.isArray(data)?data:(data.data||[]);return list.length>0?list[0]:null;}catch(e){return null;}
}

async function getVehicleList(){
  var data=await ubiGET("/vehicle/vehicles");
  var list=Array.isArray(data)?data:[];
  return list.map(function(v){
    return{imei:String(v.Imei||""),id:String(v.Imei||""),registration:v.Registration||String(v.Imei||""),driver_name:v.DriverName||"Unknown",make:v.Make||"",model:v.Model||"",company:v.Client||COMPANY,location:v.Branch||LOCATION,status:v.Status||"",ubi_id:v.Id||""};
  });
}

async function handleVehicles(){
  var vlist=await getVehicleList();
  var enriched=await Promise.all(vlist.map(async function(v){
    try{
      var os=await getObjectStatus(v.imei);
      if(os){return Object.assign({},v,{driver_name:os.driver||v.driver_name||"Unknown",speed:os.speed||"0",ignition:os.ignition_status||"Unknown",status_text:os.status_hidden||"Unknown",last_seen:os.last_data||"",location_address:os.location||"",coordinates:os.coordinates||"",vehicle_mode:os.vehicle_mode||"",battery:os.battery_percentage||""});}
    }catch(e){}
    return v;
  }));
  return json({vehicles:enriched,total:enriched.length});
}

async function handleObjectStatusAll(){
  var vlist=await getVehicleList();
  var statuses=await Promise.all(vlist.map(async function(v){
    var os=await getObjectStatus(v.imei);
    return{imei:v.imei,registration:v.registration,make:v.make,model:v.model,driver:os?os.driver||"Unknown":"Unknown",speed:os?os.speed||"0":"0",ignition:os?os.ignition_status||"Unknown":"Unknown",status:os?os.status_hidden||"Unknown":"Unknown",last_seen:os?os.last_data||"":"",location:os?os.location||"":"",coordinates:os?os.coordinates||"":"",vehicle_mode:os?os.vehicle_mode||"":"",battery:os?os.battery_percentage||"":"",gsm:os?os.gsm||"":""};
  }));
  return json({vehicles:statuses,total:statuses.length,updated:new Date().toISOString()});
}

async function handleDriverScore(url){
  var imei=url.searchParams.get("imei")||null;
  var annual_km=parseInt(url.searchParams.get("annual_km")||"15000");
  var start=toNetstar(url.searchParams.get("start_date"))||DATE_FROM;
  var end=toNetstar(url.searchParams.get("end_date"),true)||DATE_TO;
  if(!imei)throw new Error("imei parameter required");
  var os=await getObjectStatus(imei);
  var vlist=await getVehicleList();
  var vinfo=null;
  for(var vi=0;vi<vlist.length;vi++){if(vlist[vi].imei===imei){vinfo=vlist[vi];break;}}
  var driverName=os?os.driver||"Unknown":(vinfo&&vinfo.driver_name)||"Unknown";
  var speedInfo=null;
  var speedPenaltyOverride=null;
  if(os&&os.coordinates){
    var match=os.coordinates.match(/([-\d.]+),([-\d.]+)/);
    if(match){
      var lat=parseFloat(match[1]),lon=parseFloat(match[2]);
      var currentSpeed=safe(os.speed||0);
      var postedLimit=await getSpeedLimit(lat,lon);
      speedInfo=calcSpeedPenalty(currentSpeed,postedLimit);
      speedPenaltyOverride=speedInfo.penalty;
    }
  }
  var list=await getDriverPerf(start,end);
  if(!list.length)throw new Error("No driver data for this period.");
  var r=list[0];
  if(driverName&&driverName!=="Unknown"){for(var i=0;i<list.length;i++){if((list[i].driver_name||"").toLowerCase()===driverName.toLowerCase()){r=list[i];break;}}}
  var scored=calcRisk(r,speedPenaltyOverride);
  return json({imei:imei,driver_name:driverName,registration:(vinfo&&vinfo.registration)||imei,make:(vinfo&&vinfo.make)||"",model:(vinfo&&vinfo.model)||"",company:r.company_name||r.branch_name||COMPANY,period_from:start,period_to:end,features:scored.features,risk_score:scored.risk_score,risk_band:riskBand(scored.risk_score),predicted_loss_cost:lossCost(scored.risk_score,annual_km),total_distance_km:safe(r.total_running_km||0),running_time:r.total_running_duration||"N/A",avg_speed:safe(r.avg_speed||0),max_speed:safe(r.max_speed||0),speed_live:os?os.speed||"0":"0",ignition:os?os.ignition_status||"Unknown":"Unknown",location_address:os?os.location||"":"",coordinates:os?os.coordinates||"":"",last_seen:os?os.last_data||"":"",speed_limit_info:speedInfo,netstar_driver_score:0});
}

async function handleFleetScores(url){
  var annual_km=parseInt(url.searchParams.get("annual_km")||"15000");
  var start=toNetstar(url.searchParams.get("start_date"))||DATE_FROM;
  var end=toNetstar(url.searchParams.get("end_date"),true)||DATE_TO;
  var vlist=await getVehicleList();
  var osMap={};
  await Promise.all(vlist.map(async function(v){try{var os=await getObjectStatus(v.imei);if(os)osMap[v.imei]=os;}catch(e){}}));
  vlist=vlist.map(function(v){
    var os=osMap[v.imei];
    return Object.assign({},v,{driver_name:os?os.driver||v.driver_name||"Unknown":v.driver_name||"Unknown",speed:os?os.speed||"0":"0",ignition:os?os.ignition_status||"Unknown":"Unknown",location_address:os?os.location||"":"",coordinates:os?os.coordinates||"":""});
  });
  var list=await getDriverPerf(start,end);
  if(!list.length)throw new Error("No driver data for this period.");
  var scored=await Promise.all(list.map(async function(r){
    var driverName=r.driver_name||r.driver||"Unknown";
    var matchedVehicle=null;
    for(var i=0;i<vlist.length;i++){if((vlist[i].driver_name||"").toLowerCase()===driverName.toLowerCase()){matchedVehicle=vlist[i];break;}}
    if(!matchedVehicle){for(var j=0;j<vlist.length;j++){if(!vlist[j]._matched){matchedVehicle=vlist[j];vlist[j]._matched=true;break;}}}
    var imei=matchedVehicle?matchedVehicle.imei:"";
    var speedPenaltyOverride=null;
    var speedLimitInfo=null;
    var coords=matchedVehicle&&matchedVehicle.coordinates;
    if(coords){
      var match=coords.match(/([-\d.]+),([-\d.]+)/);
      if(match){
        var lat=parseFloat(match[1]),lon=parseFloat(match[2]);
        var currentSpeed=safe(matchedVehicle.speed||0);
        var postedLimit=await getSpeedLimit(lat,lon);
        speedLimitInfo=calcSpeedPenalty(currentSpeed,postedLimit);
        speedPenaltyOverride=speedLimitInfo.penalty;
      }
    }
    var s=calcRisk(r,speedPenaltyOverride);
    return{imei:imei,id:imei,registration:matchedVehicle?matchedVehicle.registration:"",driver_name:driverName,make:matchedVehicle?matchedVehicle.make:"",model:matchedVehicle?matchedVehicle.model:"",company:r.company_name||r.branch_name||COMPANY,location:matchedVehicle?matchedVehicle.location:"",speed:matchedVehicle?matchedVehicle.speed||"0":"0",ignition:matchedVehicle?matchedVehicle.ignition||"Unknown":"Unknown",location_address:matchedVehicle?matchedVehicle.location_address||"":"",coordinates:coords||"",speed_limit:speedLimitInfo?speedLimitInfo.posted:null,pct_over_limit:speedLimitInfo?speedLimitInfo.pct_over:null,features:s.features,risk_score:s.risk_score,risk_band:riskBand(s.risk_score),predicted_loss_cost:lossCost(s.risk_score,annual_km),netstar_driver_score:0,total_distance_km:safe(r.total_running_km||0),running_time:r.total_running_duration||"N/A"};
  }));
  var scoredImeis=scored.map(function(s){return s.imei;});
  vlist.forEach(function(v){if(scoredImeis.indexOf(v.imei)<0){scored.push({imei:v.imei,id:v.imei,registration:v.registration,driver_name:v.driver_name||"Unknown",make:v.make,model:v.model,company:v.company,location:v.location,speed:v.speed||"0",ignition:v.ignition||"Unknown",location_address:v.location_address||"",coordinates:v.coordinates||"",speed_limit:null,pct_over_limit:null,features:{},risk_score:null,risk_band:null,predicted_loss_cost:null,netstar_driver_score:0,total_distance_km:0,running_time:"N/A"});}});
  scored.sort(function(a,b){if(a.risk_score===null)return 1;if(b.risk_score===null)return -1;return b.risk_score-a.risk_score;});
  return json({vehicles:scored,total:scored.length,period_from:start,period_to:end});
}

async function handleDriverLookup(url){
  var DRIVER_TOKENS={"shaun-demo":"863719065635311","sholto-demo":"860896051685469","atthakan-demo":"861059061058628"};
  var token=url.searchParams.get("token")||null;
  if(!token)throw new Error("Token required.");
  var imei=DRIVER_TOKENS[token]||null;
  if(!imei)throw new Error("Invalid or expired link. Please contact your insurer.");
  var annual_km=15000;
  var now=new Date();
  var weekAgo=new Date(now-7*86400000);
  function pad2(n){return String(n).padStart(2,"0");}
  function toNS(d){return pad2(d.getDate())+"-"+pad2(d.getMonth()+1)+"-"+d.getFullYear()+" 00:00:01";}
  function toNSE(d){return pad2(d.getDate())+"-"+pad2(d.getMonth()+1)+"-"+d.getFullYear()+" 23:59:59";}
  var start=toNS(weekAgo);
  var end=toNSE(now);
  var os=await getObjectStatus(imei);
  var vlist=await getVehicleList();
  var vinfo=null;
  for(var vi=0;vi<vlist.length;vi++){if(vlist[vi].imei===imei){vinfo=vlist[vi];break;}}
  var driverName=os?os.driver||"Unknown":(vinfo&&vinfo.driver_name)||"Unknown";
  var list=await getDriverPerf(start,end);
  if(!list.length)throw new Error("No driving data available for this period.");
  var r=list[0];
  if(driverName&&driverName!=="Unknown"){for(var i=0;i<list.length;i++){if((list[i].driver_name||"").toLowerCase()===driverName.toLowerCase()){r=list[i];break;}}}
  var scored=calcRisk(r,null);
  return json({imei:imei,driver_name:driverName,registration:(vinfo&&vinfo.registration)||imei,make:(vinfo&&vinfo.make)||"",model:(vinfo&&vinfo.model)||"",period_from:start,period_to:end,features:scored.features,risk_score:scored.risk_score,risk_band:riskBand(scored.risk_score),predicted_loss_cost:lossCost(scored.risk_score,annual_km),total_distance_km:safe(r.total_running_km||0),running_time:r.total_running_duration||"N/A",avg_speed:safe(r.avg_speed||0),max_speed:safe(r.max_speed||0)});
}

async function handleTestOSM(url){
  var lat=url.searchParams.get("lat")||"-33.742725";
  var lon=url.searchParams.get("lon")||"151.0454699";
  var currentSpeed=safe(url.searchParams.get("speed")||"60");
  var limit=await getSpeedLimit(parseFloat(lat),parseFloat(lon));
  var penalty=calcSpeedPenalty(currentSpeed,limit);
  return json({lat:lat,lon:lon,posted_speed_limit:limit,current_speed:currentSpeed,speed_penalty:penalty});
}

addEventListener("fetch",function(event){event.respondWith(handle(event.request));});

async function handle(request){
  var url=new URL(request.url);
  var method=request.method.toUpperCase();
  if(method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  var csp={"Content-Security-Policy":"default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"};
  if(url.pathname==="/"||url.pathname===""){
    var html=await fetch(GITHUB_RAW+"/index.html").then(function(r){return r.text();});
    return new Response(html,{status:200,headers:Object.assign({"Content-Type":"text/html;charset=UTF-8"},csp)});
  }
  if(url.pathname==="/roi"){
    var roi=await fetch(GITHUB_RAW+"/roi.html").then(function(r){return r.text();});
    return new Response(roi,{status:200,headers:Object.assign({"Content-Type":"text/html;charset=UTF-8"},csp)});
  }
  if(url.pathname==="/driver"){
    var drv=await fetch(GITHUB_RAW+"/driver.html").then(function(r){return r.text();});
    return new Response(drv,{status:200,headers:Object.assign({"Content-Type":"text/html;charset=UTF-8"},csp)});
  }
  if(url.pathname==="/health")return json({status:"ok",version:"5.8"});
  try{
    var p=url.pathname.replace(/\/$/,"");
    if(p==="/vehicles")      return await handleVehicles();
    if(p==="/fleet-scores")  return await handleFleetScores(url);
    if(p==="/driver-score")  return await handleDriverScore(url);
    if(p==="/live-status")   return await handleObjectStatusAll();
    if(p==="/driver-lookup") return await handleDriverLookup(url);
    if(p==="/test-osm")      return await handleTestOSM(url);
    return err("Unknown route: "+p,404);
  }catch(e){
    return err("Upstream error: "+e.message,502);
  }
}
