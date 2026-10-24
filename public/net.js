// Tiny reconnecting WebSocket client with events + acknowledgements.
(function () {
  function Net(path) {
    this.path = path;
    this.handlers = {};
    this.acks = {};
    this.nextId = 1;
    this.retry = 0;
    this.connected = false;
    this.open();
  }
  Net.prototype.open = function () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + this.path);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.retry = 0; this.fire('connect'); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.ack != null) {
        const cb = this.acks[m.ack];
        delete this.acks[m.ack];
        if (cb) cb(m.d);
      } else this.fire(m.e, m.d);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      for (const id in this.acks) { this.acks[id]({ error: 'Connection lost' }); delete this.acks[id]; }
      if (was) this.fire('disconnect');
      const delay = Math.min(8000, 500 * Math.pow(1.7, this.retry++));
      setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {};
  };
  Net.prototype.on = function (e, fn) { (this.handlers[e] = this.handlers[e] || []).push(fn); };
  Net.prototype.fire = function (e, d) { (this.handlers[e] || []).forEach(fn => fn(d)); };
  Net.prototype.emit = function (e, d, cb) {
    if (!this.connected) { if (cb) cb({ error: 'Not connected — retrying…' }); return; }
    const msg = { e, d };
    if (cb) { msg.id = this.nextId++; this.acks[msg.id] = cb; }
    this.ws.send(JSON.stringify(msg));
  };
  // reconnect immediately when a phone comes back to the tab
  document.addEventListener('visibilitychange', function () {
    const n = window.__net;
    if (!document.hidden && n && n.ws.readyState > 1) { n.retry = 0; }
  });
  window.Net = Net;
})();
