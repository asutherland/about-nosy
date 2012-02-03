self.port.on('uiData', function(msg) {
  var event = document.createEvent('MessageEvent');
  event.initMessageEvent('uiData', false, false,
                         JSON.stringify(msg),
                         '*', null, null, null);
  window.dispatchEvent(event);
});

window.addEventListener('uiReq', function (event) {
  self.port.emit('uiReq', JSON.parse(event.data));
}, false);
