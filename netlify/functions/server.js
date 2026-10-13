process.env.NETLIFY = 'true';

const serverless = require('serverless-http');
const { app } = require('../../server');

exports.handler = serverless(app);