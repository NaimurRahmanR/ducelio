// Real HTTP smoke checks, against a running server; no authentication credentials.
import assert from "node:assert/strict";
const base=process.env.SMOKE_URL||"http://127.0.0.1:3000";
const demo=["","programme","calendar","classes","assignments","assessments","notes","results","support","profile","study-plan","announcements","lecture","admin","counsellor"];
let count=0;
for(const path of ["/login","/signup","/verify-email","/forgot-password","/reset-password",...demo.map(s=>"/demo"+(s?"/"+s:""))]){
 const response=await fetch(base+path);assert.equal(response.status,200,path);const html=await response.text();assert.ok(html.includes('id="main"'),path+" has a main landmark");assert.ok(!html.includes("We couldn’t open this page"),path+" is not an error boundary");count++;
}
for(const path of ["/student","/student/profile","/student/study-plan","/support","/admin"]){
 const response=await fetch(base+path,{redirect:"manual"});assert.equal(response.status,307,path);assert.equal(new URL(response.headers.get("location"),base).pathname,"/login",path);count++;
}
assert.equal((await fetch(base+"/api/admin")).status,401);count++;
assert.equal((await fetch(base+"/demo/missing-page")).status,404);count++;
console.log(count+" HTTP smoke checks passed.");

