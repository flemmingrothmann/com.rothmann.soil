"use strict";
// Run inside ingest-service. Temporary fixtures shadow production tables; rollback always.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Client } = require("pg");
const sql = fs.readFileSync(process.argv[2] || "/app/server.js", "utf8").match(/insert into energy_usage_15m \([\s\S]*?updated_at = excluded.updated_at\s*/)[0];
(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(`
      create temporary table ingest_event (event_time timestamptz, homey_device_id text,
        device_name text, capability text, value_number numeric, source_system text, event_type text);
      create temporary table energy_usage_15m (like public.energy_usage_15m including all);
      create temporary table price_interval (like public.price_interval including all);
      insert into price_interval (price_area, starts_at, ends_at, effective_dkk_per_kwh)
        values ('DK1','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',2);
      insert into ingest_event values
        ('2026-01-01T10:00:00Z','old','Meter','meter_power.imported',100,'homey','observation'),
        ('2026-01-01T10:05:00Z','new','Meter','meter_power.imported',100.5,'home_assistant','observation'),
        ('2026-01-01T10:10:00Z','old','Meter','meter_power.imported',101,'homey','observation'),
        ('2026-01-01T10:15:00Z','new','Meter','meter_power.imported',102,'home_assistant','observation'),
        ('2026-01-01T10:15:00Z','old','Meter','meter_power.imported',102,'homey','observation'),
        ('2026-01-01T10:20:00Z','new','Meter','meter_power.imported',103,'home_assistant','observation'),
        ('2026-01-01T10:21:00Z','new','Meter','meter_power.imported',1000,'home_assistant','command'),
        ('2026-01-01T10:25:00Z','old','Meter','meter_power.imported',103.5,'homey','observation'),
        ('2026-01-01T10:30:00Z','plug','Plug','meter_power',10,'homey','observation'),
        ('2026-01-01T10:35:00Z','plug','Plug','meter_power',11,'homey','observation');
    `);
    await client.query(sql, ['2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','DK1',
      ['meter_power','meter_power.imported'],JSON.stringify([{previousId:'old',currentId:'new',switchedAt:'2026-01-01T10:15:00Z'}])]);
    const result=await client.query("select homey_device_id, sum(kwh)::float as kwh, sum(cost_dkk)::float as cost from energy_usage_15m group by 1 order by 1");
    assert.deepEqual(result.rows,[{homey_device_id:'old',kwh:3,cost:6},{homey_device_id:'plug',kwh:1,cost:2}]);
    console.log('PASS: continuous meter delta across cutover, no dual-controller double counting, commands excluded, correct price, plugs separate.');
  } finally {
    await client.query("rollback");
    await client.end();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
