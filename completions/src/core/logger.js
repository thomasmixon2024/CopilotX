'use strict';

const fs = require('fs');
const path = require('path');

function createLogger(logsDir, fileName) {
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, fileName);
  return (message) => {
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  };
}

module.exports = { createLogger };
