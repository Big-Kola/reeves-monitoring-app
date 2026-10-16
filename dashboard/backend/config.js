// FuelOps Monitor - runtime paths
//
// Path resolution, in priority order:
//   1. Portable build  -> store data/storage next to the portable .exe.
//   2. Packaged build  -> store them in a "FuelOps Monitor" folder on the
//      Desktop so the Excel workbooks are easy to find and edit.
//   3. Development     -> the project-local ./data and ./storage folders.

const path = require('path');

let app = null;
try {
  app = require('electron').app || null;
} catch (err) {
  app = null;
}

const isPackaged = !!(app && app.isPackaged);
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || null;

let BASE_DIR;
if (portableDir) {
  BASE_DIR = portableDir;
} else if (isPackaged && app.getPath) {
  BASE_DIR = path.join(app.getPath('desktop'), 'FuelOps Monitor');
} else {
  BASE_DIR = path.join(__dirname, '..');
}

const DATA_DIR = path.join(BASE_DIR, 'data');
const STORAGE_DIR = path.join(BASE_DIR, 'storage');
const STORAGE_PATH = path.join(STORAGE_DIR, 'app-data.json');

module.exports = {
  BASE_DIR,
  DATA_DIR,
  STORAGE_DIR,
  STORAGE_PATH,
  isPackaged,
  isPortable: !!portableDir
};
