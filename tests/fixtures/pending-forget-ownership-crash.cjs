// Process-local crash points; production exports and behavior remain untouched.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const stage = process.env.PENDING_CRASH_STAGE;
const link = fs.linkSync;
fs.linkSync = (from, to) => {
  if (stage === 'before-link') process.exit(77);
  link(from, to);
  if (stage === 'after-link') process.exit(77);
};
const mkdir = fs.mkdirSync;
fs.mkdirSync = (path, options) => {
  const result = mkdir(path, options);
  if (stage === 'claim-created' && /\/claim\.[^/]+$/.test(path)) process.exit(77);
  return result;
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (stage === 'claim-metadata') process.exit(77);
  rename(from, to);
  if (stage === 'claim-moved') process.exit(77);
};
syncBuiltinESMExports();
