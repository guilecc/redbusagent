"use strict";
const Module = require("module");
// Use Electron internal _load override to get the electron module
const electron = Module._load("electron");
console.log("keys:", Object.keys(electron).slice(0, 10));
console.log("app:", typeof electron.app);
electron.app.whenReady().then(() => { console.log("APP READY"); electron.app.quit(); });
