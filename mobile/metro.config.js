// The app imports a few of the web app's pure logic files directly (src/lib), so time-zone,
// level and error-message rules exist once. Metro must be allowed to read that folder, and those
// files must resolve their packages (date-fns) from this app's node_modules, because CI installs
// only mobile/. `@shared/*` itself is mapped by tsconfig.json "paths", which Expo's Metro reads.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../src/lib")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
