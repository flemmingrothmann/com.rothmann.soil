# Repository Notes

## Homey Insights
- For local Homey API calls, Insights log entries are fetched with the full log id as the `:id` path segment, not only the capability id.
- Working shape: `GET /api/manager/insights/log/<ownerUri>/<fullLogId>/entry?resolution=<resolution>`.
- Example: `GET /api/manager/insights/log/homey:device:<deviceId>/homey:device:<deviceId>:meter_water/entry?resolution=last14Days`.
- The V2-style split `GET /api/manager/insights/log/homey:device:<deviceId>/meter_water/entry` returns `404` against the tested local Homey API.
- Boolean logs such as `onoff` return raw change entries; `resolution` does not trim the returned range, so callers must filter timestamps themselves for windows like the latest 14 days.
- Numeric logs such as `meter_water` are bucketed by resolution; for `last14Days` this yielded hourly points.

## Workflow
- After making and verifying code changes in this repo, deploy them unless the user explicitly says not to.
