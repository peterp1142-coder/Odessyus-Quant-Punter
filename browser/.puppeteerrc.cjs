const path = require('path');

module.exports = {
  // Point to the persistent directory where we copy Chrome during build
  cacheDirectory: path.join('/opt/render/project/.chrome'),
  skipDownload: true, // Don't download, we already have it
};
