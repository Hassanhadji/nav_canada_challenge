import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const app = express();

const port =3000;

const _filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

app.use(express.static(_dirname));



// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(_dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`http://localhost:${port}`);
});