'use strict';

const Homey = require('homey');
const fs = require('fs');
const path = require('path');

let localEnv = {};
try {
  localEnv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'env.json'), 'utf8'));
} catch (error) {
  localEnv = {};
}

const WATERING_FORBIDDEN_VARIABLE_ID = '5a2a34fd-8d2f-4c7d-b076-b1bb41e3a41f';
const WATERING_UPDATED_AT_SETTING = 'watering_forbidden_updated_at';
const HOMEY_URL_SETTING = 'watering_homey_url';
const HOMEY_TOKEN_SETTING = 'watering_homey_token';

function getConfiguredHomeyApiFromSettings(homey) {
  const url = homey.settings.get(HOMEY_URL_SETTING) || Homey.env.HOMEY_URL || localEnv.HOMEY_URL;
  const token = homey.settings.get(HOMEY_TOKEN_SETTING) || Homey.env.HOMEY_TOKEN || localEnv.HOMEY_TOKEN;
  if (!url || !token) return null;

  return {
    url: url.replace(/\/$/, ''),
    token,
  };
}

async function requestHomeyApi(api, method, pathName, body) {
  const response = await fetch(`${api.url}/api${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${api.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Homey Web API returned ${response.status}: ${responseBody || response.statusText}`);
  }

  return response.json();
}

async function getHomeyApi(homey, pathName) {
  const configuredApi = getConfiguredHomeyApiFromSettings(homey);
  if (configuredApi) {
    return requestHomeyApi(configuredApi, 'GET', pathName);
  }

  const apiResult = await homey.api.get(pathName).catch(() => null);
  if (apiResult) {
    return apiResult;
  }

  const [localUrl, token] = await Promise.all([
    homey.api.getLocalUrl(),
    homey.api.getOwnerApiToken(),
  ]);
  const response = await fetch(`${localUrl.replace(/\/$/, '')}/api${pathName}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Homey Web API returned ${response.status}: ${body || response.statusText}`);
  }

  return response.json();
}

async function putHomeyApi(homey, pathName, body) {
  const configuredApi = getConfiguredHomeyApiFromSettings(homey);
  if (configuredApi) {
    return requestHomeyApi(configuredApi, 'PUT', pathName, body);
  }

  const apiResult = await homey.api.put(pathName, body).catch(() => null);
  if (apiResult) {
    return apiResult;
  }

  const [localUrl, token] = await Promise.all([
    homey.api.getLocalUrl(),
    homey.api.getOwnerApiToken(),
  ]);
  const response = await fetch(`${localUrl.replace(/\/$/, '')}/api${pathName}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Homey Web API returned ${response.status}: ${responseBody || response.statusText}`);
  }

  return response.json();
}

async function getWateringMode(homey) {
  const variable = await getHomeyApi(homey, `/manager/logic/variable/${WATERING_FORBIDDEN_VARIABLE_ID}`);
  return {
    wateringForbidden: variable.value === true,
    updatedAt: homey.settings.get(WATERING_UPDATED_AT_SETTING) || null,
  };
}

async function toggleWateringMode(homey) {
  const current = await getWateringMode(homey);
  const nextValue = !current.wateringForbidden;
  await putHomeyApi(homey, `/manager/logic/variable/${WATERING_FORBIDDEN_VARIABLE_ID}`, { value: nextValue });

  const updatedAt = new Date().toISOString();
  await homey.settings.set(WATERING_UPDATED_AT_SETTING, updatedAt);

  return {
    wateringForbidden: nextValue,
    updatedAt,
  };
}

async function configureWateringMode(homey, config) {
  if (!config || typeof config.homeyUrl !== 'string' || typeof config.homeyToken !== 'string') {
    throw new Error('homeyUrl and homeyToken are required');
  }

  const { homeyToken } = config;
  const homeyUrl = config.homeyUrl.replace(/\/$/, '');
  await homey.settings.set(HOMEY_URL_SETTING, homeyUrl);
  await homey.settings.set(HOMEY_TOKEN_SETTING, homeyToken);

  return { configured: true };
}

module.exports = {
  configureWateringMode,
  getWateringMode,
  toggleWateringMode,
};
