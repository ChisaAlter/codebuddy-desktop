const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow importing workspace packages from outside the app dir.
config.watchFolders = [
  ...config.watchFolders,
  '../../packages/mobile-remote-protocol',
  '../../packages/mobile-remote-crypto',
];
config.resolver.nodeModulesPaths = [
  ...config.resolver.nodeModulesPaths,
  '../../node_modules',
];
config.resolver.disableHierarchicalLookup = false;

module.exports = config;