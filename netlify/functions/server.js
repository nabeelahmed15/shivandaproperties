process.env.NETLIFY = 'true';

const serverless = require('serverless-http');

// Netlify's Lambda-compatible functions do not configure Netlify Blobs
// automatically: the per-invocation credentials arrive on the event and must be
// handed to the SDK with connectLambda() before any store is opened. The app is
// therefore loaded lazily, after that call, so the first thing it does -
// restoring the saved database - already has working storage access.
let handler = null;

function getHandler() {
  if (!handler) {
    handler = serverless(require('../../server').app);
  }
  return handler;
}

exports.handler = async (event, context) => {
  try {
    const { connectLambda } = require('@netlify/blobs');
    if (typeof connectLambda === 'function') {
      connectLambda(event);
    }
    require('../../lib/sqlite-persistence').resetConnection();
  } catch (error) {
    console.warn('[shivanda] Could not prepare Netlify Blobs:', error && error.message);
  }

  return getHandler()(event, context);
};