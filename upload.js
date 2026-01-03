// FILE: C:\faris-api\upload.js
import multer from "multer";
import path from "path";
import fs from "fs";

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (_req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const safeOriginal = String(file.originalname || "file")
      .replace(/[^\w\u0600-\u06FF.\- ]+/g, "_")
      .replace(/\s+/g, "_");
    cb(null, `${unique}-${safeOriginal}`);
  },
});

export const upload = multer({ storage });
