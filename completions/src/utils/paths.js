'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function getConfigDir() {
  return path.join(ROOT, 'Config');
}

function getAgentsDir() {
  return path.join(ROOT, 'Agents');
}

function getLogsDir() {
  return path.join(ROOT, 'Logs');
}

module.exports = { getConfigDir, getAgentsDir, getLogsDir };
