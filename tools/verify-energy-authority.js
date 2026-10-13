"use strict";
const assert = require("node:assert/strict");
const { Client } = require("pg");
(async () => {
  const migration = JSON.parse(process.env.ENERGY_METER_MIGRATIONS_JSON)[0];
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const built = await client.query("select max(updated_at) as as_of from energy_usage_15m where homey_device_id=$1 and capability='meter_power.imported'", [migration.previousId]);
    const asOf = built.rows[0].as_of;
    assert(asOf && Date.parse(asOf) >= Date.parse(migration.switchedAt));
    const result = await client.query(`
      with selected as (
        select event_time, value_number from ingest_event
        where capability = 'meter_power.imported' and event_type = 'observation'
          and value_number is not null and event_time >= date_trunc('day',now()) - interval '2 days'
          and ((homey_device_id=$1 and source_system='homey' and event_time<$3)
            or (homey_device_id=$2 and source_system='home_assistant' and event_time>=$3))
      ), deltas as (
        select event_time,value_number-lag(value_number) over (order by event_time) as kwh from selected
      )
      select
        (select sum(greatest(kwh,0)) from deltas where event_time >= date_trunc('day',now())
          and event_time < $4) as expected_kwh,
        (select sum(kwh) from energy_usage_15m where homey_device_id=$1
          and capability='meter_power.imported' and bucket_start >= date_trunc('day',now())
          and bucket_start < $4) as derived_kwh,
        (select count(*) from ingest_event where homey_device_id=$1 and event_time>=$3
          and capability='meter_power.imported') as homey_after_cutover,
        (select count(*) from ingest_event where homey_device_id=$2 and event_time>=$3
          and capability='meter_power.imported') as ha_after_cutover,
        (select count(*) from energy_usage_15m where homey_device_id=$2) as duplicate_ha_buckets
    `, [migration.previousId,migration.currentId,migration.switchedAt,asOf]);
    const row = result.rows[0];
    assert(Math.abs(Number(row.expected_kwh)-Number(row.derived_kwh))<1e-8);
    assert(Number(row.homey_after_cutover)>0 && Number(row.ha_after_cutover)>0);
    assert.equal(Number(row.duplicate_ha_buckets),0);
    console.log('PASS LIVE AUTHORITY',JSON.stringify(row));
  } finally { await client.end(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
