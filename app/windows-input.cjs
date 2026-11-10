'use strict';
// Direct user32 calls: no subprocess, shell, polling or per-event compilation.
class WindowsInput {
  constructor() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Удалённый ввод поддерживается на Windows x64.');
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    this.sendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, const void *inputs, int size)');
    this.metric = user32.func('int __stdcall GetSystemMetrics(int index)');
    this.getCursorInfo = user32.func('int __stdcall GetCursorInfo(void *info)');
    this.keys = new Set(); this.buttons = new Set();
  }
  submit(type, fields) {
    // Win64 INPUT: 8-byte aligned union, total 40 bytes.
    const data = Buffer.alloc(40); data.writeUInt32LE(type, 0);
    for (const [offset, value, signed] of fields) signed ? data.writeInt32LE(value, offset) : data.writeUInt32LE(value >>> 0, offset);
    if (this.sendInput(1, data, 40) !== 1) throw new Error('Windows отклонила ввод. Запустите игру без прав администратора.');
  }
  key(scan, down) {
    const extended = scan > 255;
    const data = Buffer.alloc(40); data.writeUInt32LE(1, 0);
    data.writeUInt16LE(scan & 255, 10);
    data.writeUInt32LE(0x8 | (extended ? 0x1 : 0) | (down ? 0 : 0x2), 12);
    if (this.sendInput(1, data, 40) !== 1) throw new Error('Windows отклонила ввод клавиатуры.');
    down ? this.keys.add(scan) : this.keys.delete(scan);
  }
  button(button, down) {
    const flags = [[0x2, 0x4], [0x20, 0x40], [0x8, 0x10]][button][down ? 0 : 1];
    this.submit(0, [[20, flags]]);
    down ? this.buttons.add(button) : this.buttons.delete(button);
  }
  move(x, y) {
    const vx = this.metric(76), vy = this.metric(77), width = this.metric(78), height = this.metric(79);
    const nx = Math.round((x - vx) * 65535 / Math.max(1, width - 1));
    const ny = Math.round((y - vy) * 65535 / Math.max(1, height - 1));
    this.submit(0, [[8, Math.max(0, Math.min(65535, nx)), true], [12, Math.max(0, Math.min(65535, ny)), true], [20, 0xe001]]);
  }
  relative(dx, dy) { this.submit(0, [[8, dx, true], [12, dy, true], [20, 0x2001]]); }
  wheel(delta) { this.submit(0, [[16, delta], [20, 0x800]]); }
  release() {
    for (const scan of [...this.keys]) { try { this.key(scan, false); } catch {} }
    for (const button of [...this.buttons]) { try { this.button(button, false); } catch {} }
    this.keys.clear(); this.buttons.clear();
  }
  cursorVisible() {
    const data = Buffer.alloc(24); data.writeUInt32LE(24);
    return this.getCursorInfo(data) ? Boolean(data.readUInt32LE(4) & 1) : null;
  }
}
module.exports = { WindowsInput };
