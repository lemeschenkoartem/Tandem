'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { format } = require('./logging.js');
class Logger {
  constructor(filename, { maxBytes = 5 * 1024 * 1024, backups = 3 } = {}) {
    this.filename = filename; this.maxBytes = maxBytes; this.backups = backups; this.queue = ''; this.error = null; this.lastFlush = Promise.resolve();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.timer = setInterval(() => { this.flush(); }, 200); this.timer.unref();
  }
  record(event, data) {
    const line = format(event, data);
    if (this.queue.length < 256 * 1024) this.queue += line;
  }
  flush() {
    const batch = this.queue; this.queue = '';
    if (!batch) return this.lastFlush;
    this.lastFlush = this.lastFlush.then(async () => {
      let size = 0; try { size = (await fs.promises.stat(this.filename)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size && size + Buffer.byteLength(batch) > this.maxBytes) {
        await fs.promises.rm(this.filename + '.' + this.backups, { force: true });
        for (let i = this.backups - 1; i >= 1; i--) try { await fs.promises.rename(this.filename + '.' + i, this.filename + '.' + (i + 1)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.promises.rename(this.filename, this.filename + '.1');
      }
      await fs.promises.appendFile(this.filename, batch, { encoding: 'utf8', mode: 0o600 });
    }).catch(error => { this.error = error.code || 'LOG_WRITE_FAILED'; });
    return this.lastFlush;
  }
  async close() { clearInterval(this.timer); await this.flush(); }
}
module.exports = { Logger };
