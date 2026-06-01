# Jordstatus Browser Dashboard

Lokalt mobilvenligt dashboard til jordfugtsensorer og vandingsventiler. Det proxyer til Homey, så Homey-tokenet aldrig sendes til browseren.

## Vanding

- Fanen `Vanding` finder Sonoff Zigbee SWV-ventiler med `onoff` og `meter_water`; navnet er kun visningstekst.
- Historik læses fra Homey Insights, ikke fra Docker-volumen.
- `onoff` bruges til vandingssessioner og varighed.
- `meter_water` bruges til liter-forbrug via positive måler-deltas, så måler-reset ikke giver negativt forbrug.
- Dashboardet viser seneste 14 dage og filtrerer selv timestamps for boolean logs.

## Kør lokalt med Docker

```powershell
cd dashboard
$env:HOMEY_URL="http://<homey-ip-eller-url>"
$env:HOMEY_TOKEN="<homey-api-token>"
$env:DASHBOARD_PASSWORD="Bogfinkevej11"
docker compose up --build -d
```

Åbn derefter `http://<din-pc-ip>:8787` på telefonen og vælg browserens "Føj til startskærm".

## Miljøvariabler

- `HOMEY_URL`: Homey base-URL, f.eks. `http://192.168.1.10` eller `https://...homeylocal.com`
- `HOMEY_TOKEN`: Homey API token med adgang til app API'et
- `PORT`: intern port, default `8787`
- `DASHBOARD_PASSWORD`: adgangskode til browseren, default `Bogfinkevej11`
- `DASHBOARD_COOKIE_SECRET`: valgfri hemmelighed til signering af login-cookie
- `WATERING_FORBIDDEN_VARIABLE_ID`: Homey Logic boolean-variable for `Vanding Forbudt`

Dashboardets `Vanding forbudt` status læses fra og skrives til Homey Logic-variablen. Seneste ændringstidspunkt gemmes lokalt i Docker-volumen `soil-dashboard-data`.

Stop igen med:

```powershell
docker compose down
```
