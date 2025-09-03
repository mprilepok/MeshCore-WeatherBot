## Description
node.js weather bot using meshcore.js and companion-usb

## Requirements
You will need Meshcore device with Companion USB firmware connected to the computer

## Installation
First you need to install node.js >18.0
```sh
git clone https://github.com/recrof/MeshCore-WeatherBot.git
cd MeshCore-WeatherBot
npm install .
```

## Usage
Edit `config.json`:
```json
{
  "port": "/dev/ttyACM0", // port which is used for companion USB
  "weatherAlarm": "6:00", // time to send daily weather forecast
  "myPosition": { // position that will be used to compute storm proximity alert
    "lat": 48.14, 
    "lon": 17.11
  },
  "channels": { // what channel name should be used weather forecast and alerts
    "alerts": "Public",
    "weather": "Public"
  },
  "timers": { 
    "blitzCollection": 600000, // how often should we aggregate thunder data for evaluation
    "pollWeatherAlerts": 600000 // how often should we download weather altert data
  },
  "blitzArea": { // thunder reporting area. if there is storm detected inside, report it
    "minLat": 47.51,
    "minLon": 15.54,
    "maxLat": 48.76,
    "maxLon": 18.62
  },
  "compasNames": { // compass direction names in your local language
    "N": "Severne",
    "NE": "Severo-Vychodne",
    "E": "Vychodne",
    "SE": "Juho-Vychodne",
    "S": "Juzne",
    "SW": "Juho-Zapadne",
    "W": "Zapadne",
    "NW": "Severo-Zapadne"
  }
}
```
then run:
```
node index.mjs
```


**Note:**
This weather bot is currently hardcoded to use weather data from shmu.sk for Bratislava region.
If this does not apply to your region, you will need to implement your own functions to retrieve weater forecasts.
