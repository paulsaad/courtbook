// Expo's default Metro setup plus Sentry's debug IDs, which tie each bundle to its uploaded source
// maps so crash reports show real file names and lines. Nothing else is changed (no extra watch
// folders: the app must bundle from mobile/ alone — see check:bundle).
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
