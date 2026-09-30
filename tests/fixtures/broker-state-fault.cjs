const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const original = {
  closeSync: fs.closeSync,
  fsyncSync: fs.fsyncSync,
  openSync: fs.openSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  writeFileSync: fs.writeFileSync,
};
const descriptors = new Map();
const tracePath = process.env.OPENCODE_BROKER_STATE_FAULT_TRACE;
const fault = process.env.OPENCODE_BROKER_STATE_FAULT_STEP ?? "";
const armPath = process.env.OPENCODE_BROKER_STATE_FAULT_ARM;
const statePath = process.env.OPENCODE_BROKER_STATE_FAULT_PATH;
const stateRoot = statePath ? require("node:path").dirname(statePath) : null;
const isTemp = (path) => typeof path === "string" && path.startsWith(`${statePath}.`) && path.endsWith(".tmp");
const record = (event) => original.writeFileSync(tracePath, `${JSON.stringify(event)}\n`, { flag: "a" });
const faultIsArmed = () => fault !== "" && fs.existsSync(armPath);

fs.openSync = (path, flags, mode) => {
  const descriptor = original.openSync(path, flags, mode);
  if (isTemp(path) || path === stateRoot) {
    descriptors.set(descriptor, path);
    record({ operation: "open", target: isTemp(path) ? "temp" : "directory", flags, mode });
  }
  return descriptor;
};
fs.writeFileSync = (pathOrDescriptor, data, options) => {
  const path = descriptors.get(pathOrDescriptor) ?? pathOrDescriptor;
  if (isTemp(path)) record({ operation: "write", target: "temp", bytes: Buffer.byteLength(data) });
  return original.writeFileSync(pathOrDescriptor, data, options);
};
fs.fsyncSync = (descriptor) => {
  const path = descriptors.get(descriptor);
  if (isTemp(path)) {
    record({ operation: "fsync", target: "temp" });
    if (fault === "fsync-temp" && faultIsArmed()) throw new Error("simulated broker temp fsync failure");
  } else if (path === stateRoot) {
    record({ operation: "fsync", target: "directory" });
    if (fault === "fsync-directory" && faultIsArmed()) throw new Error("simulated broker directory fsync failure");
  }
  return original.fsyncSync(descriptor);
};
fs.closeSync = (descriptor) => {
  const path = descriptors.get(descriptor);
  if (path) record({ operation: "close", target: isTemp(path) ? "temp" : "directory" });
  descriptors.delete(descriptor);
  return original.closeSync(descriptor);
};
fs.renameSync = (from, to) => {
  if (isTemp(from) && to === statePath) record({ operation: "rename", target: "state" });
  return original.renameSync(from, to);
};
fs.unlinkSync = (path) => {
  if (isTemp(path)) record({ operation: "unlink", target: "temp" });
  return original.unlinkSync(path);
};

syncBuiltinESMExports();
