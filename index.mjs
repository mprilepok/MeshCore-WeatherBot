import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { DOMParser } from 'linkedom';
import * as mqtt from 'mqtt';
import * as utils from './utils.mjs';
import config from './config.json' with { type: 'json' };

const port = process.argv[2] ?? config.port;

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

  for(const [channelType, channel] of Object.entries(config.channels)) {
    channels[channelType] = await connection.findChannelByName(channel);
    if (!channels[channelType]) {
      console.log(`Channel ${channelType}: "${channel}" not found!`);
      connection.close();
      return;
    }
  }

  await pollWeatherAlerts();
  await registerBlitzortungMqtt(blitzHandler, config.blitzArea);
  utils.setAlarm(config.weatherAlarm, sendWeather);
  setInterval(blitzWarning, config.timers.blitzCollection);

  console.log('weatherBot ready.');
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
  }

  setTimeout(pollWeatherAlerts, config.timers.pollWeatherAlerts);
}

async function sendWeather(date) {
  const chunks = utils.splitStringToByteChunks(await getWeather(), 130);
  if (chunks.length === 0) return;

  for (const message of chunks) {
    await sendAlert(message, channels.weather);
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
    const weatherBits = Array.from(weatherEl.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).filter(t => /\w/.test(t));

    weatherBits.push(
      ...Array.from(weatherEl.querySelectorAll('p')).map(e => e.textContent).filter(t => !/^Formul|Rozhovor/.test(t))
    );

    weather = utils.trimAndNormalize(weatherBits.join(' '));
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
  const blitz = utils.calculateHeadingAndDistance(config.myPosition.lat, config.myPosition.lon, blitzData.lat, blitzData.lon);
  blitzBuffer.push(blitz);
}

async function sendAlert(message, channel) {
  await connection.sendChannelTextMessage(
    channel.channelIdx,
    utils.shortenToBytes(message, 155)
  );
  console.log(`Sent out [${channel.name}]: ${message}`);
  await utils.sleep(30 * 1000);
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

    messageParts.push(`${distance * 10}km ${config.compasNames[heading]}`);
    seen.blitz[key] = 1;
  }
  if (messageParts.length == 0) return;

  await sendAlert(`🌩️ ${messageParts.join(', ')}`, channels.alerts);

  blitzBuffer = [];
}

await connection.connect();
