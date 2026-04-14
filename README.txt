Rothmann Soil Sensors brings soil moisture sensors from multiple brands into one consistent Homey experience.

I think soil moisture sensors are underserved in Homey. First of all, Third Reality's sensor is almost the only readily available soil moisture sensor in Homey, and it can be a bit pricey.

Tuya owners are more lucky, not because of Tuya itself, but because a lot of very cheap, usable sensors are available in that ecosystem.

I also think the current sensor support lacks usability. What I really want is to use Homey's zone card `Any <alarm> on` in a flow to trigger an alert when a soil moisture sensor detects that it is time for watering, meaning the soil has become too dry.

Two things stand in the way of that today:

1. No soil moisture sensor emits such an alarm.
2. `Soil Dry` is not a standard alarm, so Homey's zone card does not work with it as a custom alarm capability.

The closest candidate is `alarm_water`, but that really means the opposite. Still, it works well enough for my use case, unless you also have water leakage sensors around. In that case, you would get incorrect zone alarms.

I do not have leakage sensors yet, so I am happy to use `alarm_water` for now.

I do not expect to get a request like this accepted upstream by, for example, Third Reality, because they also have leakage sensors in their product line. It would not be a safe default for the broader audience anyway, since many users are likely mixing leak sensors and soil sensors.

But I am not.

To try to get Homey's attention, I created a feature request about better flow and zone support for custom alarm capabilities:

https://community.homey.app/t/feature-request-better-flow-and-zone-support-for-custom-alarm-capabilities/153765

If that works out, my plan is to get this work into the official Homey apps, and-or implement it in this project with a proper migration away from `alarm_water` usage.

So this project is about making practical soil moisture support work today, including the use of `alarm_water`, and writing my own drivers where needed. That includes a modified Third Reality driver and potentially various Tuya-based sensors.

https://github.com/philipostli/com.arteco is a great project that already implements the ZS-301Z Tuya sensor. Since I have a few ZS-304Z devices, I am building on Philip's great work. If he agrees, that is where the Tuya work should ideally go.

Otherwise, it will live here in this project.

The ZS-304Z is currently in a pull request on Philip's repository.

The first supported device in this app is the Third Reality Smart Soil Moisture Sensor. The app focuses on practical monitoring and alerting with a shared approach that can later expand to additional soil sensors.
