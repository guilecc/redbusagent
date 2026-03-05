"use strict";
console.log("process.type:", process.type);
console.log("versions.electron:", process.versions.electron);
try {
  const { app } = require("electron");
  console.log("app:", typeof app);
} catch(e) {
  console.log("require error:", e.message);
}
