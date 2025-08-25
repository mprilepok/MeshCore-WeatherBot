import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { DOMParser } from 'linkedom';
import * as mqtt from 'mqtt';
import * as utils from './utils.mjs';

const port = process.argv[2] ?? '/dev/ttyACM0';

const timers = { // miliseconds
  blitzCollection: 10 * 60 * 1000, // 10 minutes
  pollWeatherAlerts: 10 * 60 * 1000, // 10 minutes
};

const blitzArea = {
  // minLat: 45.0,
  // maxLon: 27.0,
  minLat: 47.51,
  minLon: 15.54,
  maxLat: 48.76,
  maxLon: 18.62,
};

const myPosition = {
  lat: 48.14,
  lon: 17.11
};

const compas8SK = {
  N: 'Severne',
  NE: 'Severo-Vychodne',
  E: 'Vychodne',
  SE: 'Juho-Vychodne',
  S: 'Juzne',
  SW: 'Juho-Zapadne',
  W: 'Zapadne',
  NW: 'Severo-Zapadne'
};

const channels = {
  alerts: null,
  weather: null
};

const seen = {
  blitz: {},
  warnings: {},
};

let blitzBuffer = [];

console.log(`Connecting to ${port}`);
const connection = new NodeJSSerialConnection(port);

connection.on('connected', async () => {
  console.log(`Connected to ${port}`);

  channels.alerts = await connection.findChannelByName('ARES');
  if (!channels.alerts) {
    console.log('Channel ARES not found!');
    connection.close();
    return;
  }

  channels.weather = await connection.findChannelByName('Omega');
  if (!channels.weather) {
    console.log('Channel Omega not found!');
    connection.close();
    return;
  }

  // update clock on meshcore device
  await connection.syncDeviceTime();

  await pollWeatherAlerts();
  await registerBlitzortungMqtt(blitzHandler, blitzArea);
  utils.setAlarm('7:23', sendWeather);
  setInterval(blitzWarning, timers.blitzCollection);
});

// listen for new messages
connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const waitingMessages = await connection.getWaitingMessages();
    for (const message of waitingMessages) {
      if (message.contactMessage) {
        await onContactMessageReceived(message.contactMessage);
      } else if (message.channelMessage) {
        await onChannelMessageReceived(message.channelMessage);
      }
    }
  } catch (e) {
    console.log(e);
  }
});

async function onContactMessageReceived(message) {
  console.log('Received contact message', message);
}

async function onChannelMessageReceived(message) {
  console.log(`Received channel message`, message);
}

async function pollWeatherAlerts() {
  const warnings = await getWarnings();

  for (const warning of warnings) {
    const hash = utils.shaSumHex(`${warning.type}_${warning.severity}_${warning.startTime}_${warning.endTime}`);
    if (seen.warnings[hash]) continue;

    await sendAlert(`[${warning.severity}][${warning.type}]: ${warning.text}`, channels.alerts);
    seen.warnings[hash] = true;

    await utils.sleep(15 * 1000);
  }

  setTimeout(pollWeatherAlerts, timers.pollWeatherAlerts);
}

async function sendWeather(date) {
  const currentDateString = date.toLocaleDateString('sk', { weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric' });
  const chunks = utils.splitStringToByteChunks(await getWeather(), 130);
  if (chunks.length === 0) return;

  chunks.unshift(`Pocasie pre ${currentDateString}:`);
  for (const message of chunks) {
    await sendAlert(message, channels.weather);
    await utils.sleep(15 * 1000);
  }
}

async function getWeather() {
  let weather = '';

  try {
    const res = await fetch('https://www.shmu.sk/sk/?page=1&id=meteo_tpredpoved_ba');
    const html = await res.text();
    console.debug(`downloaded ${html.length} bytes from shmu.sk`);

    const document = new DOMParser().parseFromString(html, 'text/html');
    const weatherEl = document.querySelector('.mp-section');

    const situationText = utils.trimAndNormalize(
      Array.from(weatherEl.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('')
    );
    const forecastText = utils.trimAndNormalize(weatherEl.querySelector('p').textContent);

    weather = `${situationText} ${forecastText}`;
  }
  catch (e) {
    console.error(e)
  }

  return weather;
}

async function getWarnings() {
  const warnings = [];

  try {
    const res = await fetch('https://www.meteoblue.com/sk/počasie/warnings/bratislava_slovensko_3060972');
    const html = await res.text();
    console.debug(`downloaded ${html.length} bytes from meteoblue.com`);
    const document = new DOMParser().parseFromString(html, 'text/html');
    //console.debug(document);

    for (const warnEl of document.querySelectorAll('.warning-wrapper[defaultlang="sk"]')) {
      console.debug(warnEl);
      const glyphClasses = warnEl.querySelector('.warning-logos > .glyph').className.split(' ');
      const type = glyphClasses.find(c => c.startsWith('warning-type-')).replace('warning-type-', '');
      const severity = glyphClasses.find(c => c.startsWith('sev-')).replace('sev-', '');
      const text = warnEl.querySelector('.warning-heading .title').textContent.trim();
      const [startTime, endTime] = warnEl.querySelector('.warning .times').getAttribute('title').replaceAll(/(Štart|Koniec): /g, '').split('\n');

      warnings.push({ type, severity, text, startTime, endTime });
    }
  }
  catch (e) {
    console.error(e)
  }

  return warnings;
}

async function registerBlitzortungMqtt(blitzCallback, blitzArea) {
  const client = await mqtt.connectAsync('mqtt://blitzortung.ha.sed.pl:1883');
  const decoder = new TextDecoder();

  client.on('message', (_, data) => {
    const json = decoder.decode(data);
    const blitzData = JSON.parse(json);
    if (blitzData.lat < blitzArea.minLat || blitzData.lon < blitzArea.minLon ||
      blitzData.lat > blitzArea.maxLat || blitzData.lon > blitzArea.maxLon) { return }
    blitzCallback(blitzData);
  });

  await client.subscribeAsync('blitzortung/1.1/#');
}

function blitzHandler(blitzData) {
  const blitz = utils.calculateHeadingAndDistance(myPosition.lat, myPosition.lon, blitzData.lat, blitzData.lon);
  blitzBuffer.push(blitz);
}

async function sendAlert(message, channel) {
  await connection.sendChannelTextMessage(
    channel.channelIdx,
    utils.shortenToBytes(message, 155)
  );
  console.log(`Sent out [${channel.name}]: ${message}`);
}

async function blitzWarning() {
  const counter = {};
  const messageParts = [];

  for (const blitz of blitzBuffer) {
    const key = `${blitz.heading}|${(blitz.distance / 10) | 0}`
    counter[key] = counter[key] ?? 0;
    counter[key]++;
  }

  for (const key of Object.keys(counter)) {
    if (counter[key] < 10 || seen.blitz[key]) continue;
    const [heading, distance] = key.split('|');
    if (!(heading && distance)) continue;

    messageParts.push(`${distance * 10}km ${compas8SK[heading]}`);
    seen.blitz[key] = 1;
  }
  if (messageParts.length == 0) return;

  await sendAlert(`[STORM]: ${messageParts.join(', ')}`, channels.alerts);

  blitzBuffer = [];
}

await connection.connect();
