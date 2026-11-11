"use strict";

const fs = require("fs");
const path = require("path");

function readJson(filename, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error; // Never silently discard a damaged persistent queue or metadata cache.
  }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
}

class PersistentQueue {
  constructor(filename) {
    this.filename = filename;
    this.items = readJson(filename, []);
    if (!Array.isArray(this.items)) throw new Error("Invalid persistent queue");
  }

  push(item) {
    const next = [...this.items, item];
    writeJson(this.filename, next);
    this.items = next;
  }

  shift() {
    const next = this.items.slice(1);
    writeJson(this.filename, next);
    this.items = next;
  }

  get length() { return this.items.length; }
  get first() { return this.items[0]; }
}

module.exports = { readJson, writeJson, PersistentQueue };
