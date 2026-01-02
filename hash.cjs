const bcrypt = require("bcrypt");

bcrypt.hash("Admin#2025", 10).then((h) => {
  console.log("HASH:", h);
  process.exit(0);
}).catch((err) => {
  console.error("ERR:", err);
  process.exit(1);
});
