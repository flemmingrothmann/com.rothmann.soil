"use strict";
// Run inside soil-dashboard; credentials are read from its environment and never printed.
const assert = require("node:assert/strict");
const MAIN = "home_assistant:energy_main";
const HISTORY = "9369fb97-310f-4105-92a2-5a285f14ab00";
const wingman = process.env.WINGMAN_URL;
async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
(async () => {
  const current = await json(`${wingman}/api/current-state`);
  const states = current.states.filter(s => s.homey_device_id === MAIN);
  assert.equal(states.length, 4);
  assert(states.every(s => s.source_system === "home_assistant" && s.available));
  const meter = states.find(s => s.capability === "meter_power.imported");
  assert(Date.now() - Date.parse(meter.event_time) < 120000);
  console.log("HA OBSERVATIONS", JSON.stringify(states.map(s=>({capability:s.capability,value:s.value,unit:s.unit,time:s.event_time,source:s.source_system}))));
  if (process.argv[2] === "observer") return;
  assert.equal(process.env.ENERGY_MAIN_DEVICE_ID, MAIN);
  assert.equal(process.env.ENERGY_USAGE_DEVICE_ID, HISTORY);
  const from = new Date(Date.now()-2*86400000).toISOString();
  const to = new Date().toISOString();
  await json(`${wingman}/api/energy/rebuild`, {method:"POST", headers:{authorization:`Bearer ${process.env.INGEST_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({from,to,priceArea:"DK1"})});
  const usage = await json(`${wingman}/api/energy/usage?interval=hour&deviceId=${HISTORY}&from=${from}&to=${to}`);
  assert(usage.buckets.some(b=>b.kwh>0 && b.cost_dkk!==null));
  console.log("METER USAGE", JSON.stringify(usage.buckets.slice(-3)));
  const root="http://127.0.0.1:8787";
  const login=await fetch(`${root}/login`,{method:"POST",body:new URLSearchParams({password:process.env.DASHBOARD_PASSWORD}),redirect:"manual"});
  assert.equal(login.status,303);
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const overview=await json(`${root}/api/overview-dashboard`,{headers:{cookie}});
  const cards=overview.cards || overview.sections?.flatMap(s=>s.cards) || [];
  const electricity=cards.find(c=>c.id==="electricity");
  console.log("OVERVIEW KEYS",Object.keys(overview));
  assert(electricity, "Electricity overview card missing");
  assert(Number.isFinite(electricity.electricity.now.kw));
  assert(Number.isFinite(electricity.electricity.now.dkkPerHour));
  console.log("DASHBOARD ELECTRICITY",JSON.stringify(electricity.electricity));
  const energy=await json(`${root}/api/energy-dashboard?period=day`,{headers:{cookie}});
  assert(energy.totals.kwh>0 && energy.totals.costDkk>0);
  console.log("DASHBOARD DAILY ENERGY",JSON.stringify(energy.totals));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
