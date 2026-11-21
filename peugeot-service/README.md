# Peugeot på Hubert

`psa_car_controller` henter køretøjsdata fra samme Stellantis-backend som MyPeugeot. Servicen er kun tilgængelig for dashboardet på Docker-netværket og på Huberts loopback-interface til første login.

## Start og login

```bash
docker compose --project-directory /opt/soil/peugeot-service -f /opt/soil/peugeot-service/compose.yaml up -d
ssh -L 5000:127.0.0.1:5000 fro@192.168.100.67
```

Åbn derefter `http://127.0.0.1:5000`, og gennemfør MyPeugeot-login, SMS-kode og bilens firecifrede pinkode. Login-data gemmes i Docker-volumenet `peugeot-car-controller-data` og må ikke lægges i repoet.

Tilføj bilens VIN til `/opt/soil/dashboard/.env`:

```text
PEUGEOT_VIN=<vin>
```

Dashboardet bruger internt `http://peugeot-car-controller:5000`. Genstart dashboardet efter ændringen.

På Hubert kan VIN læses og konfigureres uden at printe den:

```bash
tools/configure-peugeot-dashboard.sh
```

MyPeugeot-data opdateres ikke nødvendigvis, mens bilen sover. Dashboardet viser derfor både bilens datatidsstempel og om data er forældede.
